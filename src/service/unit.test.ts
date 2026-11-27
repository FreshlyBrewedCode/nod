import { expect, test } from "bun:test";

import {
  LAUNCHD_LABEL,
  parseLaunchctlPrint,
  parsePlistProgramArguments,
  renderLaunchdPlist,
} from "./launchd";
import { captureEnv, isFragileEntry, serviceCommand, type ServiceSpec } from "./spec";
import { parseSystemdExecStart, parseSystemdShow, renderSystemdUnit } from "./systemd";

const spec: ServiceSpec = {
  command: ["/home/mara/.bun/bin/bun", "/home/mara/nod/src/cli.ts", "serve", "--port", "4600"],
  cwd: "/home/mara/code/widgets",
  env: { PATH: "/home/mara/.bun/bin:/usr/bin:/bin", XDG_CONFIG_HOME: "/home/mara/.cfg" },
  logFile: "/Users/mara/Library/Logs/nod/nod.log",
};

test("the systemd unit", () => {
  expect(renderSystemdUnit(spec))
    .toBe(`# Written by \`nod service install\`; \`nod service uninstall\` removes it.
[Unit]
Description=nod, the local server of the nod dashboard

[Service]
Type=simple
WorkingDirectory=/home/mara/code/widgets
ExecStart="/home/mara/.bun/bin/bun" "/home/mara/nod/src/cli.ts" "serve" "--port" "4600"
Environment="PATH=/home/mara/.bun/bin:/usr/bin:/bin"
Environment="XDG_CONFIG_HOME=/home/mara/.cfg"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`);
});

test("the launchd plist", () => {
  expect(renderLaunchdPlist(spec)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by \`nod service install\`; \`nod service uninstall\` removes it. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>de.frebreco.nod</string>
  <key>ProgramArguments</key>
  <array>
    <string>/home/mara/.bun/bin/bun</string>
    <string>/home/mara/nod/src/cli.ts</string>
    <string>serve</string>
    <string>--port</string>
    <string>4600</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/home/mara/code/widgets</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/home/mara/.bun/bin:/usr/bin:/bin</string>
    <key>XDG_CONFIG_HOME</key>
    <string>/home/mara/.cfg</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>/Users/mara/Library/Logs/nod/nod.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/mara/Library/Logs/nod/nod.log</string>
</dict>
</plist>
`);
  expect(LAUNCHD_LABEL).toBe("de.frebreco.nod");
});

const awkward = [
  "/opt/my tools/bun",
  'a "quoted" \\ arg',
  "50%",
  "$HOME",
  "<a&b>",
  "--repo",
  "acme/widgets",
];

test("systemd quoting survives spaces, quotes, backslashes, % and $", () => {
  const unit = renderSystemdUnit({ ...spec, command: awkward });
  expect(unit).toContain('"50%%" "$$HOME"');
  expect(parseSystemdExecStart(unit)).toEqual(awkward);
});

test("plist escaping round-trips", () => {
  const plist = renderLaunchdPlist({ ...spec, command: awkward });
  expect(plist).toContain("<string>&lt;a&amp;b&gt;</string>");
  expect(parsePlistProgramArguments(plist)).toEqual(awkward);
});

test("a newline in an argument is refused, not written", () => {
  expect(() => renderSystemdUnit({ ...spec, command: ["bun", "a\nb"] })).toThrow("newline");
  expect(() => renderSystemdUnit({ ...spec, env: { PATH: "a\nExecStart=evil" } })).toThrow(
    "newline",
  );
});

test("ExecStart of a hand-edited unit", () => {
  expect(parseSystemdExecStart("[Service]\nExecStart=-/usr/bin/bun  /x/cli.ts serve\n")).toEqual([
    "/usr/bin/bun",
    "/x/cli.ts",
    "serve",
  ]);
  expect(parseSystemdExecStart("[Service]\n")).toBeNull();
  expect(parsePlistProgramArguments("<plist/>")).toBeNull();
});

test("systemctl show", () => {
  expect(parseSystemdShow("ActiveState=active\nMainPID=812\n")).toEqual({ active: true, pid: 812 });
  expect(parseSystemdShow("ActiveState=inactive\nMainPID=0\n")).toEqual({
    active: false,
    pid: null,
  });
  expect(parseSystemdShow("ActiveState=activating\nMainPID=0\n").active).toBe(false);
  expect(parseSystemdShow("").active).toBe(false);
});

test("launchctl print", () => {
  const running = `gui/501/de.frebreco.nod = {\n\tactive count = 1\n\tpath = /x\n\tstate = running\n\n\tpid = 3120\n}`;
  expect(parseLaunchctlPrint(running)).toEqual({ active: true, pid: 3120 });
  const waiting = `gui/501/de.frebreco.nod = {\n\tstate = waiting\n\tlast exit code = 1\n}`;
  expect(parseLaunchctlPrint(waiting)).toEqual({ active: false, pid: null });
});

test("the command is the runtime, the entry, serve and the flags", () => {
  expect(serviceCommand({ runtime: "/b/bun", entry: "/n/cli.ts" }, ["--poll", "30"])).toEqual([
    "/b/bun",
    "/n/cli.ts",
    "serve",
    "--poll",
    "30",
  ]);
});

test("captured environment: PATH and where files are, never tokens", () => {
  expect(
    captureEnv({
      PATH: "/bin",
      XDG_CONFIG_HOME: "/c",
      GH_CONFIG_DIR: "/gh",
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      HOME: "/home/mara",
      XDG_CACHE_HOME: "",
    }),
  ).toEqual({ PATH: "/bin", XDG_CONFIG_HOME: "/c", GH_CONFIG_DIR: "/gh" });
  expect(captureEnv({}).PATH).toBe("/usr/local/bin:/usr/bin:/bin");
});

test("a cache or temp entry point is fragile", () => {
  expect(isFragileEntry("/tmp/bunx-1000-@frebreco/nod/bin/nod.js", "/tmp")).toBe(true);
  expect(isFragileEntry("/home/mara/.bun/install/cache/@frebreco/nod/bin/nod.js", "/tmp")).toBe(
    true,
  );
  expect(isFragileEntry("/home/mara/nod/src/cli.ts", "/tmp")).toBe(false);
  expect(
    isFragileEntry("/home/mara/.bun/install/global/node_modules/@frebreco/nod/bin/nod.js", "/tmp"),
  ).toBe(false);
});
