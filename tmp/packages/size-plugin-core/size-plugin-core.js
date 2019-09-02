const path = require("path");
const promisify = require("util.promisify");
const globPromise = require("glob");
const minimatch = require("minimatch");
const gzipSize = require("gzip-size");
const chalk = require("chalk");
const prettyBytes = require("pretty-bytes");
const brotliSize = require("brotli-size");
const { publishSizes, publishDiff } = require("size-plugin-store");
const fs = require("fs-extra");
const { noop, toFileMap, toMap, dedupe } = require("./util");

const glob = promisify(globPromise);

brotliSize.file = (path, options) => {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(path);
    stream.on("error", reject);

    const brotliStream = stream.pipe(brotliSize.stream(options));
    brotliStream.on("error", reject);
    brotliStream.on("brotli-size", resolve);
  });
};
const compression = {
  brotli: brotliSize,
  gzip: gzipSize
};
/**
 * `SizePluginCore(options)`
 * @param {Object} options
 * @param {string} [options.compression] compression method(gzip/brotli) to use, default: 'gzip'
 * @param {string} [options.pattern] minimatch pattern of files to track
 * @param {string} [options.exclude] minimatch pattern of files NOT to track
 * @param {string} [options.filename] file name to save filesizes to disk
 * @param {boolean} [options.publish] option to publish filesizes to size-plugin-store
 * @param {boolean} [options.writeFile] option to save filesizes to disk
 * @param {boolean} [options.mode] option for production/development mode
 * @param {function} [options.stripHash] custom function to remove/normalize hashed filenames for comparison
 * @param {(item:Item)=>string?} [options.decorateItem] custom function to decorate items
 * @param {(data:Data)=>string?} [options.decorateAfter] custom function to decorate all output
 * @public
 */
module.exports = function Core(options) {
  const opt = options || {};
  opt.pattern = opt.pattern || "**/*.{mjs,js,jsx,css,html}";
  opt.filename = opt.filename || "size-plugin.json";
  opt.writeFile = opt.writeFile !== false;
  opt.stripHash = opt.stripHash || noop;
  opt.filepath = path.join(process.cwd(), opt.filename);
  opt.mode = opt.mode || process.env.NODE_ENV;
  opt.compression = opt.compression || "gzip";
  const compressionSize = compression[opt.compression];

  async function readFromDisk(filename) {
    try {
      const oldStats = await fs.readJSON(filename);
      return oldStats.sort((a, b) => b.timestamp - a.timestamp);
    } catch (err) {
      return [];
    }
  }
  async function writeToDisk(filename, stats) {
    if (
      opt.mode === "production" &&
      stats.files.some(file => file.diff !== 0)
    ) {
      const data = await readFromDisk(filename);
      data.unshift(stats);
      if (opt.writeFile) {
        await fs.ensureFile(filename);
        await fs.writeJSON(filename, data);
      }
      opt.publish && (await publishSizes(data, opt.filename));
    }
  }
  async function save(files) {
    const stats = {
      timestamp: Date.now(),
      files: files.map(file => ({
        filename: file.name,
        previous: file.sizeBefore,
        size: file.size,
        diff: file.size - file.sizeBefore
      }))
    };
    opt.publish && (await publishDiff(stats, opt.filename));
    opt.save && (await opt.save(stats));
    await writeToDisk(opt.filepath, stats);
  }
  async function load(outputPath) {
    const data = await readFromDisk(opt.filepath);
    if (data.length) {
      const [{ files }] = data;
      return toFileMap(files);
    }
    return getSizes(outputPath);
  }
  async function getSizes(cwd) {
    const files = await glob(opt.pattern, { cwd, ignore: opt.exclude });

    const sizes = await Promise.all(
      filterFiles(files).map(file =>
        compressionSize.file(path.join(cwd, file)).catch(() => null)
      )
    );

    return toMap(files.map(filename => opt.stripHash(filename)), sizes);
  }
  function filterFiles(files) {
    const isMatched = minimatch.filter(opt.pattern);
    const isExcluded = opt.exclude
      ? minimatch.filter(opt.exclude)
      : () => false;
    return files.filter(file => isMatched(file) && !isExcluded(file));
  }
  async function outputSizes(assets, outputPath) {
    // map of filenames to their previous size
    // Fix #7 - fast-async doesn't allow non-promise values.
    const sizesBefore = await load(outputPath);
    const assetNames = filterFiles(Object.keys(assets));

    const sizes = await Promise.all(
      assetNames.map(name => compressionSize(assets[name].source))
    );

    // map of de-hashed filenames to their final size
    const finalSizes = toMap(
      assetNames.map(filename => opt.stripHash(filename)),
      sizes
    );

    // get a list of unique filenames
    const files = [
      ...Object.keys(sizesBefore),
      ...Object.keys(finalSizes)
    ].filter(dedupe);

    const width = Math.max(...files.map(file => file.length));
    let output = "";
    const items = [];
    for (const name of files) {
      const size = finalSizes[name] || 0;
      const sizeBefore = sizesBefore[name] || 0;
      const delta = size - sizeBefore;
      const msg = new Array(width - name.length + 2).join(" ") + name + " ⏤  ";
      const color =
        size > 100 * 1024
          ? "red"
          : size > 40 * 1024
          ? "yellow"
          : size > 20 * 1024
          ? "cyan"
          : "green";
      let sizeText = chalk[color](prettyBytes(size));
      let deltaText = "";
      if (delta && Math.abs(delta) > 1) {
        deltaText = (delta > 0 ? "+" : "") + prettyBytes(delta);
        if (delta > 1024) {
          sizeText = chalk.bold(sizeText);
          deltaText = chalk.red(deltaText);
        } else if (delta < -10) {
          deltaText = chalk.green(deltaText);
        }
        sizeText += ` (${deltaText})`;
      }
      let text = msg + sizeText + "\n";
      const item = {
        name,
        sizeBefore,
        size,
        sizeText,
        delta,
        deltaText,
        msg,
        color
      };
      items.push(item);
      if (opt.decorateItem) {
        text = opt.decorateItem(text, item) || text;
      }
      output += text;
    }
    if (opt.decorateAfter) {
      const opts = {
        sizes: items,
        raw: { sizesBefore, sizes: finalSizes },
        output
      };
      const text = opt.decorateAfter(opts);
      if (text) {
        output += "\n" + text.replace(/^\n/g, "");
      }
    }
    await save(items);
    return output;
  }
  return { outputSizes, options: opt };
};

/**
 * @name Item
 * @typedef Item
 * @property {string} name Filename of the item
 * @property {number} sizeBefore Previous size, in kilobytes
 * @property {number} size Current size, in kilobytes
 * @property {string} sizeText Formatted current size
 * @property {number} delta Difference from previous size, in kilobytes
 * @property {string} deltaText Formatted size delta
 * @property {string} msg Full item's default message
 * @property {string} color The item's default CLI color
 * @public
 */

/**
 * @name Data
 * @typedef Data
 * @property {Item[]} sizes List of file size items
 * @property {string} output Current buffered output
 * @public
 */
