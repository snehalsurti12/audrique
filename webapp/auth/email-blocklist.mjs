/**
 * Free email domain blocklist — business email enforcement.
 * Customers must register with a work email, not personal/free providers.
 */

export const FREE_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com",
  "icloud.com", "mail.com", "protonmail.com", "proton.me", "zoho.com",
  "yandex.com", "gmx.com", "gmx.net", "live.com", "msn.com",
  "me.com", "mac.com", "fastmail.com", "tutanota.com", "tuta.io",
  "hushmail.com", "mailfence.com", "runbox.com", "posteo.de",
  "disroot.org", "riseup.net", "cock.li", "airmail.cc",
  "yahoo.co.uk", "yahoo.co.in", "yahoo.ca", "yahoo.com.au",
  "outlook.co.uk", "hotmail.co.uk", "hotmail.fr", "hotmail.de",
  "hotmail.it", "hotmail.es", "live.co.uk", "live.fr",
  "googlemail.com", "rediffmail.com", "inbox.com", "mail.ru",
  "ymail.com", "pm.me", "hey.com", "duck.com",
  "guerrillamail.com", "sharklasers.com", "mailinator.com",
  "tempmail.com", "throwaway.email",
]);

/**
 * Check if an email uses a free/personal domain.
 * @param {string} email
 * @returns {boolean} true if the domain is blocked (free provider)
 */
export function isFreeDomain(email) {
  const domain = (email || "").split("@")[1]?.toLowerCase()?.trim();
  if (!domain) return true; // No domain = invalid
  return FREE_DOMAINS.has(domain);
}
