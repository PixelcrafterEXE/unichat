#!/usr/bin/env node
// Verifies the Android build prerequisites and prints exactly what is missing. Exit code 1 if anything REQUIRED is missing.
//   node scripts/check-android-env.mjs [--release]     (--release also requires signing material)
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, "..");
const release = process.argv.includes("--release");
const vars = readFileSync(join(root, "android/variables.gradle"), "utf8");
const want = { ndk: /ndkVersion = '([^']+)'/.exec(vars)?.[1], compile: /compileSdkVersion = (\d+)/.exec(vars)?.[1] };
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || (existsSync(join(homedir(), "Android/Sdk")) ? join(homedir(), "Android/Sdk") : "");
const missing = [], notes = [];
const row = (ok, what, detail = "", fix = "", required = true) => {
  console.log(`${ok ? " ok " : required ? "FAIL" : "warn"}  ${what}${detail ? "  " + detail : ""}`);
  if (!ok) (required ? missing : notes).push(`${what}: ${fix}`);
};
const run = (cmd, args, env) => { const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env } }); return r.error ? undefined : (r.stdout + r.stderr).trim(); };

// JDK 21 (AGP 8.13 / Capacitor 8). JDK 22+ is rejected by this Gradle wrapper.
const jh = process.env.JAVA_HOME;
const javaBin = jh ? join(jh, "bin/java") : "java";
const jv = run(javaBin, ["-version"]);
const major = Number(/version "(\d+)/.exec(jv ?? "")?.[1] ?? 0);
row(major === 21 || major === 17, "JDK 17/21", jv ? `(${jh ?? "PATH"}: major ${major})` : "(java not found)",
  "install JDK 21 and `export JAVA_HOME=/path/to/jdk-21` (the default `java` on PATH is " + (major || "missing") + "; Gradle/AGP need 17-21, the project compiles with 21)");
row(!!jh, "JAVA_HOME set", "", "export JAVA_HOME so Gradle does not pick a newer default JDK", false);

row(!!sdk && existsSync(sdk), "Android SDK", sdk || "(ANDROID_HOME unset)", "install the Android command-line tools and `export ANDROID_HOME=$HOME/Android/Sdk`");
if (sdk && existsSync(sdk)) {
  const has = (p) => existsSync(join(sdk, p));
  const ls = (p) => { try { return readdirSync(join(sdk, p)); } catch { return []; } };
  const sdkm = "sdkmanager (cmdline-tools/latest/bin)";
  row(has(`platforms/android-${want.compile}`), `platforms;android-${want.compile}`, "", `sdkmanager "platforms;android-${want.compile}"`);
  const bt = ls("build-tools"); row(bt.length > 0, "build-tools", bt.join(","), `sdkmanager "build-tools;36.0.0"`);
  row(has(`ndk/${want.ndk}`), `ndk;${want.ndk}`, ls("ndk").join(",") ? "(installed: " + ls("ndk").join(",") + ")" : "", `sdkmanager "ndk;${want.ndk}"  (variables.gradle pins this exact version)`);
  const cm = ls("cmake"); row(cm.some((v) => v.startsWith("3.22")), "cmake;3.22.1", cm.join(","), `sdkmanager "cmake;3.22.1"`);
  row(has("platform-tools/adb"), "platform-tools (adb)", "", `sdkmanager "platform-tools"`, false);
  row(has("cmdline-tools/latest/bin/sdkmanager"), sdkm, "", "install the command-line tools from developer.android.com/studio#command-line-tools-only", false);
}
// nodejs-mobile prebuilt (scripts/fetch-nodejs-mobile.mjs)
const ln = join(root, "android/app/libnode");
for (const abi of ["arm64-v8a", "x86_64"]) row(existsSync(join(ln, "bin", abi, "libnode.so")), `libnode.so ${abi}`, "", "node scripts/fetch-nodejs-mobile.mjs --sha256-file <file> (see README)");
row(existsSync(join(ln, "include/node/node.h")), "libnode headers (include/node/node.h)", "", "node scripts/fetch-nodejs-mobile.mjs");
row(existsSync(join(root, "android/app/src/main/assets/nodejs-project/main.js")), "backend bundle in assets", "", "pnpm --filter @unimsg/android bundle");
row(existsSync(join(root, "../ui/dist/index.html")), "UI build (apps/ui/dist)", "", "pnpm --filter @unimsg/ui build", false);
row(existsSync(join(root, "android/app/src/main/assets/public/index.html")), "UI copied into the app (cap sync)", "", "pnpm --filter @unimsg/android exec cap sync android", false);
// optional toolchains
const cargo = run("cargo", ["--version"]); row(!!cargo, "cargo (only for libsignal, scripts/build-libsignal-android.sh)", cargo ?? "", "install rustup + `rustup target add aarch64-linux-android x86_64-linux-android` + `cargo install cargo-ndk`", false);
if (release) {
  const e = (n) => process.env[n] || "";
  for (const n of ["UNIMSG_KEYSTORE", "UNIMSG_KEYSTORE_PASSWORD", "UNIMSG_KEY_ALIAS", "UNIMSG_KEY_PASSWORD"]) row(!!e(n), n, "", `export ${n} (or put it in ~/.gradle/gradle.properties); never commit it`);
  if (e("UNIMSG_KEYSTORE")) row(existsSync(e("UNIMSG_KEYSTORE")), "keystore file exists", e("UNIMSG_KEYSTORE"), "keytool -genkeypair -v -keystore unichat-release.jks -alias unichat -keyalg RSA -keysize 4096 -validity 10000");
}
console.log(missing.length ? `\n${missing.length} required item(s) missing:\n - ${missing.join("\n - ")}` : "\nall required pieces present");
if (notes.length) console.log("optional:\n - " + notes.join("\n - "));
process.exit(missing.length ? 1 : 0);
