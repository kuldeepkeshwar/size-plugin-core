const path = require("path");
const promisify = require("util.promisify");
const globPromise = require("glob");
const minimatch = require("minimatch");
const gzipSize = require("gzip-size");
const chalk = require("chalk");
const prettyBytes = require("pretty-bytes");
const { publishSizes, publishDiff } = require("size-plugin-store");
const fs = require("fs-extra");
const { noop, toFileMap, toMap, dedupe } = require("./util");

const glob = promisify(globPromise);

/**
 * `core(options)`
 * @param {Object} options
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
module.exports = function Core(_options) {
  const options = _options || {};
  options.pattern = options.pattern || "**/*.{mjs,js,css,html}";
  options.filename = options.filename || "size-plugin.json";
  options.writeFile = options.writeFile !== false;
  options.stripHash = options.stripHash || noop;
  options.filepath = path.join(process.cwd(), options.filename);
  options.mode = options.mode || process.env.NODE_ENV;

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
      options.mode === "production" &&
      stats.files.some(file => file.diff !== 0)
    ) {
      const data = await readFromDisk(filename);
      data.unshift(stats);
      if (options.writeFile) {
        await fs.ensureFile(filename);
        await fs.writeJSON(filename, data);
      }
      options.publish && (await publishSizes(data, options.filename));
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
    options.publish && (await publishDiff(stats, options.filename));
    options.save && (await options.save(stats));
    await writeToDisk(options.filepath, stats);
  }
  async function load(outputPath) {
    const data = await readFromDisk(options.filepath);
    if (data.length) {
      const [{ files }] = data;
      return toFileMap(files);
    }
    return getSizes(outputPath);
  }
  async function getSizes(cwd) {
    const files = await glob(options.pattern, { cwd, ignore: options.exclude });

    const sizes = await Promise.all(
      files.map(file => gzipSize.file(path.join(cwd, file)).catch(() => null))
    );

    return toMap(files.map(filename => options.stripHash(filename)), sizes);
  }
  async function outputSizes(assets, outputPath) {
    // console.log(assets, outputPath);
    // map of filenames to their previous size
    // Fix #7 - fast-async doesn't allow non-promise values.
    const sizesBefore = await load(outputPath);
    const isMatched = minimatch.filter(options.pattern);
    const isExcluded = options.exclude
      ? minimatch.filter(options.exclude)
      : () => false;
    const assetNames = Object.keys(assets).filter(
      file => isMatched(file) && !isExcluded(file)
    );
    const sizes = await Promise.all(
      assetNames.map(name => gzipSize(assets[name].source))
    );

    // map of de-hashed filenames to their final size
    const finalSizes = toMap(
      assetNames.map(filename => options.stripHash(filename)),
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
      if (options.decorateItem) {
        text = options.decorateItem(text, item) || text;
      }
      output += text;
    }
    if (options.decorateAfter) {
      const opts = {
        sizes: items,
        raw: { sizesBefore, sizes: finalSizes },
        output
      };
      const text = options.decorateAfter(opts);
      if (text) {
        output += "\n" + text.replace(/^\n/g, "");
      }
    }
    await save(items);
    return output;
  }
  return { outputSizes, options };
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
