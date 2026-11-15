/**
 * Host half of the usage-popup bundle.
 *
 * All behaviour lives in the Client half (`./client.js`): the banner, the
 * settings page, the chime, and the persisted preferences all run in the Web
 * renderer, so this half deliberately imports nothing. That keeps the bundle
 * installable as a plain linked directory, where Node resolves imports from the
 * bundle folder instead of the profile's `node_modules`.
 */

/** Bundle name, matching the loader row in `cordis.patch.yml`. */
export const name = 'dsh-usage-popup'

/**
 * Activate the bundle.
 *
 * The entry has to apply for the Client half to be mounted; it registers no
 * Host resource of its own.
 *
 * @param {import('@deepseek-ai/cordis').Context} _ctx - this entry's context.
 */
export function apply(_ctx) {}
