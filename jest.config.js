const { createDefaultPreset } = require("ts-jest");

const tsJestTransformCfg = createDefaultPreset().transform;

/** @type {import("jest").Config} **/
module.exports = {
  testEnvironment: "node",
  // Tests that run real SQLite + HTTP fixtures came close to the 5 s default under a full parallel run (random CI
  // failures, 2026-11-06).
  testTimeout: 20000,
  transform: {
    ...tsJestTransformCfg,
  },
};