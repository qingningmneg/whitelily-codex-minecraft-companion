"use strict";

const { resolve } = require("node:path");
const verifier = require("../../../packaging/electron/after-pack.cjs");

module.exports = (context) =>
  verifier.materializePreparedNodeModulesAndVerify(
    context,
    resolve(__dirname, "../../../build/electron-bundle"),
  );
