/**
 * The small part of `oidc-provider` (which ships no type definitions) that the test IdP uses.
 * Shapes follow the library's own runtime API.
 */
declare module 'oidc-provider' {
  import type { IncomingMessage, ServerResponse } from 'node:http';

  export interface Interaction {
    uid: string;
    params: Record<string, unknown>;
    prompt: { name: string; reasons: string[]; details: Record<string, unknown> };
  }

  export interface Grant {
    addOIDCScope(scope: string): void;
    save(): Promise<string>;
    destroy(): Promise<void>;
  }

  export interface GrantModel {
    new (properties: { accountId: string; clientId: string }): Grant;
    find(id: string): Promise<Grant | undefined>;
  }

  export interface Account {
    accountId: string;
    claims(use: string, scope: string): Promise<Record<string, unknown>>;
  }

  export class Prompt {
    constructor(options: { name: string; requestable?: boolean });
  }

  export interface PromptList extends Array<Prompt> {
    add(prompt: Prompt, index?: number): void;
  }

  export const interactionPolicy: {
    base(): PromptList;
    Prompt: typeof Prompt;
  };

  export default class Provider {
    constructor(issuer: string, configuration: Record<string, unknown>);
    readonly Grant: GrantModel;
    callback(): (req: IncomingMessage, res: ServerResponse) => void;
    interactionDetails(req: IncomingMessage, res: ServerResponse): Promise<Interaction>;
    interactionFinished(
      req: IncomingMessage,
      res: ServerResponse,
      result: Record<string, unknown>,
    ): Promise<void>;
  }
}
