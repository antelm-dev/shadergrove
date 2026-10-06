/**
 * The reference a preference stores to point at one contribution of one
 * package: `plugin:<packageId>/<contributionId>`. A theme and a language are
 * chosen this way.
 *
 * It names no version, so updating a package keeps the choice; whether the
 * contribution still exists is only ever decided against the current
 * installations, never assumed from the string.
 */
import { CONTRIBUTION_ID_PATTERN, PACKAGE_ID_PATTERN } from './ids';

export type PluginContributionRef = `plugin:${string}/${string}`;

const REF_PREFIX = 'plugin:';
/** The longest reference the two id patterns allow. */
export const PLUGIN_REF_MAX_LENGTH = REF_PREFIX.length + 64 + 1 + 48;

export function pluginContributionRef(
  packageId: string,
  contributionId: string,
): PluginContributionRef {
  if (!PACKAGE_ID_PATTERN.test(packageId) || !CONTRIBUTION_ID_PATTERN.test(contributionId)) {
    throw new Error(`Not a contribution reference: ${packageId}/${contributionId}`);
  }
  return `${REF_PREFIX}${packageId}/${contributionId}`;
}

/**
 * Split a reference into its two ids, or `null` for anything that is not
 * exactly one. Syntax only: a well-formed reference may still name a
 * contribution that is not installed.
 */
export function parsePluginContributionRef(
  value: unknown,
): { packageId: string; contributionId: string } | null {
  if (typeof value !== 'string' || value.length > PLUGIN_REF_MAX_LENGTH) return null;
  if (!value.startsWith(REF_PREFIX)) return null;
  const rest = value.slice(REF_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const packageId = rest.slice(0, slash);
  const contributionId = rest.slice(slash + 1);
  if (!PACKAGE_ID_PATTERN.test(packageId) || !CONTRIBUTION_ID_PATTERN.test(contributionId)) {
    return null;
  }
  return { packageId, contributionId };
}

export function isPluginContributionRef(value: unknown): value is PluginContributionRef {
  return parsePluginContributionRef(value) !== null;
}
