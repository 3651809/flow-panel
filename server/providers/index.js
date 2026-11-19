'use strict';

/**
 * provider 注册表。加腾讯云只要新增一个文件并在这里注册，面板和采集器都不用改。
 */

const huawei = require('./huawei');

module.exports = {
  huawei,
  tencent: require('./tencent')
};
