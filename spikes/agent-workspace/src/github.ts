// Spike 5's GitHub App calls, kept free of Workers imports so they can be checked under Node as well.
//
// The App authenticates with a JWT it signs with its private key (RS256, through WebCrypto), and trades that for an
// installation token scoped to one repository and one permission. The token never leaves the Durable Object: the git
// client sends it as a header, and nothing here returns it in a record.

const API = "https://api.github.com";
const HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "actord-spike-5" };

/** What GitHub granted, without the token itself. */
export interface Grant {
  expiresAt: string;
  permissions: Record<string, string>;
  repositorySelection: string;
  repositories: string[];
}

/**
 * A JWT for the App, valid for nine minutes (GitHub allows ten) and backdated a minute for clock drift.
 *
 * `pem` may be PKCS#1 ("BEGIN RSA PRIVATE KEY", what GitHub hands out) or PKCS#8 ("BEGIN PRIVATE KEY"). WebCrypto
 * imports only PKCS#8, so a PKCS#1 key is wrapped first.
 */
export async function appJwt(appId: string, pem: string, now = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", privateKeyInfo(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const iat = Math.floor(now / 1000) - 60;
  const id = appId.trim();
  const claims = { iat, exp: iat + 540, iss: /^\d+$/.test(id) ? Number(id) : id };
  const signing = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signing));
  return `${signing}.${base64url(new Uint8Array(signature))}`;
}

/** An installation token for `repository` only, with `contents: write` only. */
export async function installationToken(jwt: string, installationId: string, repository: string): Promise<{ token: string; grant: Grant }> {
  const response = await fetch(`${API}/app/installations/${encodeURIComponent(installationId.trim())}/access_tokens`, {
    method: "POST",
    headers: { ...HEADERS, Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ repositories: [repository], permissions: { contents: "write" } }),
  });
  const body = (await response.json().catch(() => ({}))) as { token?: string; expires_at?: string; permissions?: Record<string, string>; repository_selection?: string; repositories?: { full_name: string }[]; message?: string };
  if (response.status !== 201 || typeof body.token !== "string") throw new Error(`GitHub refused the installation token: ${response.status} ${body.message ?? ""}`.trim());
  return {
    token: body.token,
    grant: { expiresAt: body.expires_at ?? "", permissions: body.permissions ?? {}, repositorySelection: body.repository_selection ?? "", repositories: (body.repositories ?? []).map((r) => r.full_name) },
  };
}

/** The commit a branch points at, read with the installation token, or null when the branch doesn't exist. */
export async function branchHead(token: string, repo: string, branch: string): Promise<string | null> {
  const response = await fetch(`${API}/repos/${repo}/branches/${encodeURIComponent(branch)}`, { headers: { ...HEADERS, Authorization: `Bearer ${token}` } });
  if (response.status === 404) return null;
  const body = (await response.json().catch(() => ({}))) as { commit?: { sha?: string } };
  if (!response.ok) throw new Error(`GitHub branch lookup failed: ${response.status}`);
  return body.commit?.sha ?? null;
}

/** Revokes the token early (it would expire in an hour). Returns GitHub's status, 204 on success. */
export async function revoke(token: string): Promise<number> {
  const response = await fetch(`${API}/installation/token`, { method: "DELETE", headers: { ...HEADERS, Authorization: `Bearer ${token}` } });
  await response.body?.cancel();
  return response.status;
}

/** The DER of a PEM private key, as PKCS#8. Literal "\n" sequences, as a pasted secret may have, become newlines. */
export function privateKeyInfo(pem: string): Uint8Array<ArrayBuffer> {
  const text = pem.replace(/\\n/g, "\n");
  const match = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]*?)-----END (RSA )?PRIVATE KEY-----/.exec(text);
  if (!match) throw new Error("GITHUB_APP_PRIVATE_KEY is not a PEM private key");
  const der = Uint8Array.from(atob(match[2]!.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  return match[1] ? pkcs1ToPkcs8(der) : der;
}

/**
 * Wraps an RSAPrivateKey (PKCS#1) in a PrivateKeyInfo (PKCS#8):
 * SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING { the PKCS#1 key } }.
 */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const version = [0x02, 0x01, 0x00];
  const rsaEncryption = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const key = [0x04, ...derLength(pkcs1.length), ...pkcs1];
  const body = [...version, ...rsaEncryption, ...key];
  return new Uint8Array([0x30, ...derLength(body.length), ...body]);
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function base64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
