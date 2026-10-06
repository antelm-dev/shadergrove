/** Public release catalogue; independent of GitHub's response and updater manifests. */
export type ReleaseChannel = 'stable' | 'beta';
export type DesktopPlatform = 'windows' | 'linux' | 'macos';
export type DesktopArchitecture = 'x64' | 'arm64' | 'universal';
export type DesktopPackage = 'installer' | 'portable' | 'appimage' | 'deb' | 'dmg' | 'zip';

export interface DesktopDownload {
  name: string;
  url: string;
  size: number;
  platform: DesktopPlatform;
  arch: DesktopArchitecture;
  kind: DesktopPackage;
}

export interface PublicRelease {
  version: string;
  channel: ReleaseChannel;
  title: string;
  publishedAt: string;
  notes: string;
  url: string;
  downloads: DesktopDownload[];
}

export interface ReleasePage {
  releases: PublicRelease[];
  nextPage: number | null;
}

export interface LatestRelease {
  release: PublicRelease | null;
}
