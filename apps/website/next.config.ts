import type { NextConfig } from 'next';

const config: NextConfig = {
  // A static site for now: every page prerenders to out/. Server features (a public shader
  // gallery, accounts) would need a hosting decision before this changes.
  output: 'export',
  reactStrictMode: true,
  // The brand library ships TypeScript sources, like the other workspace libraries.
  transpilePackages: ['@shadergrove/brand', '@shadergrove/shared'],
  // `next dev` would otherwise write AGENTS.md and CLAUDE.md into this app on every run.
  agentRules: false,
};

export default config;
