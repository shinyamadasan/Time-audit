import base from '../../playwright.config.js';
export default { ...base, testDir: '.', outputDir: './run-output', workers: 1 };
