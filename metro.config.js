const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.resolver.unstable_enablePackageExports = false;
config.resolver.blockList = [/node_modules\/pngjs\/.*/];
module.exports = config;
