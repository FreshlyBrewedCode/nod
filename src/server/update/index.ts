/**
 * The update check, the channel and the installer seam (epic D). Pure server
 * parts, not wired to the protocol or the UI yet.
 */

export { CHECK_INTERVAL_MS, UpdateChecker, distTag } from "./checker";
export type {
  InstallProgress,
  InstallStatus,
  UpdateCheckerOptions,
  UpdateKind,
  UpdateState,
  UpdateStatus,
} from "./checker";
export { defaultChannel, jsonFileChannelStore, memoryChannelStore } from "./channel-store";
export type { ChannelStore } from "./channel-store";
export { FakeInstaller } from "./fake-installer";
export { FAKE_RELEASES, FakeReleaseFeed } from "./fake-release-feed";
export { GitHubReleaseFeed, NOD_REPOSITORY } from "./github-release-feed";
export {
  PACKAGE_NAME,
  createInstaller,
  detectInstallMethod,
  installArgs,
  installCommand,
  spawnRunner,
} from "./installer";
export type { InstallInfo, InstallMethod, InstallResult, Installer, Runner } from "./installer";
export { CHANNELS, FeedError, FeedRateLimited, isChannel, selectRelease } from "./release-feed";
export type { Channel, ReleaseFeed, ReleaseInfo } from "./release-feed";
export { compareSemver, parseSemver } from "./semver";
