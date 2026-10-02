import deckyPlugin from "@decky/rollup";
import replace from "@rollup/plugin-replace";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default deckyPlugin({
  plugins: [
    replace({
      preventAssignment: true,
      __PLUGIN_VERSION__: JSON.stringify(pkg.version),
    }),
  ],
});
