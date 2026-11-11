import { HttpResponse, http } from 'msw';
import {
  ApiToken,
  type CreateApiTokenRequest,
  type Me,
  Passkey,
  type UpdateProfileRequest,
} from '../api/dto.ts';
import { fx } from './fixtures.ts';
import { API, apiError, server } from './server.ts';

// Noon UTC, so the date reads the same in every time zone.
const CREATED = Date.UTC(2026, 10, 1, 12);
const DAY = 86_400_000;

export function fxPasskey(o: Partial<Passkey> = {}): Passkey {
  return Passkey.parse({
    id: 'pk_1',
    name: 'MacBook',
    transports: ['internal'],
    created_at: CREATED,
    last_used_at: null,
    ...o,
  });
}

export function fxToken(o: Partial<ApiToken> = {}): ApiToken {
  return ApiToken.parse({
    id: 'tok_1',
    name: 'ci',
    prefix: 'pw_abcdefgh',
    created_at: CREATED,
    last_used_at: null,
    expires_at: null,
    ...o,
  });
}

/** What the secret of a token created through `serveAccount` is. */
export const NEW_TOKEN_SECRET = 'pw_abcdefghIJKLMNOPqrstuvwxyz0123456789ABCDEF';

/** The ceremony `POST /me/passkeys/options` hands out. */
export const PASSKEY_CEREMONY = {
  ceremony_id: 'c1',
  options: { challenge: 'Y2hhbGxlbmdl', rp: { name: 'Pinwall' } },
};

export const LAST_CREDENTIAL_MESSAGE =
  'You cannot remove your last way to sign in. Add a passkey or a password first.';

/** One request the mock server took: the method, the path after `/api/v1`, and the parsed JSON body. */
export interface Call {
  method: string;
  path: string;
  body: unknown;
}

export interface AccountState {
  me: Me;
  /** The owner's current password, or `null` for a passkey-only owner. */
  password: string | null;
  passkeys: Passkey[];
  tokens: ApiToken[];
}

/**
 * Serves the account routes the Settings pages use, with the rules the real
 * server enforces: a wrong current password is a 401, and the last way to
 * sign in cannot be removed (409). The `state` changes as the pages write to
 * it, and `me` always reports the credentials it holds. `calls` lists every
 * write, in order.
 */
export function serveAccount(
  o: {
    me?: Partial<Me>;
    /** Default `'old password 1'`. */
    password?: string | null;
    passkeys?: Passkey[];
    tokens?: ApiToken[];
  } = {},
): { state: AccountState; calls: Call[] } {
  const passkeys = o.passkeys ?? [];
  const password = o.password === undefined ? 'old password 1' : o.password;
  const state: AccountState = {
    me: fx.me({ credentials: { password: password !== null, passkeys: passkeys.length }, ...o.me }),
    password,
    passkeys,
    tokens: o.tokens ?? [],
  };
  const calls: Call[] = [];
  const syncCredentials = () => {
    if (state.me.kind === 'owner') {
      state.me = {
        ...state.me,
        credentials: { password: state.password !== null, passkeys: state.passkeys.length },
      };
    }
  };
  const record = async (request: Request) => {
    const path = new URL(request.url).pathname.replace(/^.*\/api\/v1/, '');
    const text = await request.text();
    calls.push({ method: request.method, path, body: text ? JSON.parse(text) : undefined });
  };
  const lastCredential = () => apiError(409, 'conflict', LAST_CREDENTIAL_MESSAGE);

  server.use(
    http.get(`${API}/me`, () => HttpResponse.json(state.me)),
    http.patch(`${API}/me`, async ({ request }) => {
      await record(request.clone());
      const body = (await request.json()) as UpdateProfileRequest;
      state.me = { ...state.me, ...body } as Me;
      return HttpResponse.json(state.me);
    }),
    http.put(`${API}/me/password`, async ({ request }) => {
      await record(request.clone());
      const body = (await request.json()) as { current_password?: string; new_password: string };
      if (state.password !== null && body.current_password !== state.password) {
        return apiError(401, 'invalid_credentials', 'Wrong password.');
      }
      state.password = body.new_password;
      syncCredentials();
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete(`${API}/me/password`, async ({ request }) => {
      await record(request.clone());
      if (state.passkeys.length < 1) return lastCredential();
      state.password = null;
      syncCredentials();
      return new HttpResponse(null, { status: 204 });
    }),

    http.get(`${API}/me/passkeys`, () => HttpResponse.json(fx.page(state.passkeys))),
    http.post(`${API}/me/passkeys/options`, async ({ request }) => {
      await record(request.clone());
      return HttpResponse.json(PASSKEY_CEREMONY);
    }),
    http.post(`${API}/me/passkeys`, async ({ request }) => {
      await record(request.clone());
      const body = (await request.json()) as { name?: string };
      const added = fxPasskey({
        id: `pk_${state.passkeys.length + 1}`,
        name: body.name ?? `Passkey ${state.passkeys.length + 1}`,
        created_at: Date.now(),
      });
      state.passkeys = [...state.passkeys, added];
      syncCredentials();
      return HttpResponse.json(added, { status: 201 });
    }),
    http.patch(`${API}/me/passkeys/:id`, async ({ request, params }) => {
      await record(request.clone());
      const { name } = (await request.json()) as { name: string };
      const found = state.passkeys.find((p) => p.id === params.id);
      if (!found)
        return apiError(404, 'not_found', 'This passkey does not exist, or it is not yours.');
      const renamed = { ...found, name };
      state.passkeys = state.passkeys.map((p) => (p.id === found.id ? renamed : p));
      return HttpResponse.json(renamed);
    }),
    http.delete(`${API}/me/passkeys/:id`, async ({ request, params }) => {
      await record(request.clone());
      if (state.password === null && state.passkeys.length <= 1) return lastCredential();
      state.passkeys = state.passkeys.filter((p) => p.id !== params.id);
      syncCredentials();
      return new HttpResponse(null, { status: 204 });
    }),

    http.get(`${API}/me/tokens`, () => HttpResponse.json(fx.page(state.tokens))),
    http.post(`${API}/me/tokens`, async ({ request }) => {
      await record(request.clone());
      const body = (await request.json()) as CreateApiTokenRequest;
      const token = fxToken({
        id: `tok_${state.tokens.length + 1}`,
        name: body.name,
        created_at: Date.now(),
        expires_at: body.expires_in_days ? Date.now() + body.expires_in_days * DAY : null,
      });
      state.tokens = [token, ...state.tokens];
      return HttpResponse.json({ token, secret: NEW_TOKEN_SECRET }, { status: 201 });
    }),
    http.delete(`${API}/me/tokens/:id`, async ({ request, params }) => {
      await record(request.clone());
      state.tokens = state.tokens.filter((t) => t.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return { state, calls };
}
