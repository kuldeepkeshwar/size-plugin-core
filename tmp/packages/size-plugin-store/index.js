
const axios = require('axios');
const cienv = require('ci-env');
const { repo, sha, event, branch, ci } =cienv;

const SIZE_STORE_ENDPOINT = process.env.SIZE_STORE_ENDPOINT || 'https://size-store.now.sh' ;

// TODO: add option to turn off publishing of sizes.

async function publishDiff(diff,filename) {
	if (process.env.NODE_ENV !=='test' &&  ci && event == 'pull_request') {
		try {
			const params = { ci,repo, branch, sha,filename, diff };
			await axios.post(`${SIZE_STORE_ENDPOINT}/diff`, params);
		}
		catch (error) {
			console.error('error: while publishing diff', error);
		}
	}
}
async function publishSizes(size,filename) {
	// TODO: read allowed branch from configuration
	if (process.env.NODE_ENV !=='test' &&  ci && event == 'push' && branch==='master') {
		try {
			const params = { ci,repo, branch, sha,filename,size };
			await axios.post(`${SIZE_STORE_ENDPOINT}/size`, params);
		}
		catch (error) {
			console.error('error: while publishing sizes', error);
		}
	}
}
module.exports = {publishDiff,publishSizes}