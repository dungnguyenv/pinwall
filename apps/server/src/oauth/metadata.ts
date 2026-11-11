import type { Config } from '../config/types.ts';
import { publicUrl } from '../http/public-url.ts';
import { OAUTH_SCOPE } from './constants.ts';

type PublicConfig = Pick<Config, 'publicOrigin'>;

/** The MCP endpoint as an OAuth protected resource (RFC 8707 `resource`, RFC 9728 `resource`). */
export function mcpResourceUrl(config: PublicConfig): string {
  return publicUrl(config, '/mcp');
}

/** Where the MCP resource's metadata lives; `/mcp`'s 401 challenge names it. */
export function resourceMetadataUrl(config: PublicConfig): string {
  return publicUrl(config, '/.well-known/oauth-protected-resource/mcp');
}

/**
 * RFC 8414 authorization server metadata. The issuer is the bare public origin, so clients find
 * this document at `/.well-known/oauth-authorization-server` and every URL in it is public.
 * Public clients only, PKCE S256 only, and the `iss` authorization response parameter
 * (RFC 9207) is always sent.
 */
export function authorizationServerMetadata(config: PublicConfig): Record<string, unknown> {
  return {
    issuer: config.publicOrigin,
    authorization_endpoint: publicUrl(config, '/oauth/authorize'),
    token_endpoint: publicUrl(config, '/oauth/token'),
    registration_endpoint: publicUrl(config, '/oauth/register'),
    revocation_endpoint: publicUrl(config, '/oauth/revoke'),
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [OAUTH_SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
}

/** RFC 9728 protected resource metadata for `/mcp`; Pinwall is its own authorization server. */
export function protectedResourceMetadata(config: PublicConfig): Record<string, unknown> {
  return {
    resource: mcpResourceUrl(config),
    authorization_servers: [config.publicOrigin],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Pinwall',
  };
}

/**
 * A `resource` parameter (RFC 8707) in the form `mcpResourceUrl` compares against: the
 * lowercased scheme and host, the port only when it is not the default, and the path without
 * one trailing `/`. Null when it is not an absolute http(s) URL, or has a query or a fragment
 * (even an empty one).
 */
export function normalizeResource(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // `href` keeps a `?` or `#` even when what follows is empty; neither can occur elsewhere.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (/[?#]/.test(url.href)) return null;
  const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  return url.origin + path;
}
