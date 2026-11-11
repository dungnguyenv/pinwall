/*
 * The API shapes the web app uses, in one place. Everything comes from
 * `@pinwall/shared`, the same zod schemas the server validates with.
 *
 * When a screen needs a DTO that a parallel milestone adds to the shared
 * package but this branch does not have yet, define it here under the name
 * that milestone's plan gives it. The merge then turns that definition into a
 * re-export, and no other file changes.
 */
export {
  AddPasskeyRequest,
  ApiToken,
  ApiTokenList,
  ArtifactList,
  ArtifactSummary,
  CeremonyOptions,
  ChangePasswordRequest,
  CreateApiTokenRequest,
  CreatedApiToken,
  CreateProjectRequest,
  ErrorBody,
  Label,
  Me,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  Passkey,
  PasskeyAuthenticationResponse,
  PasskeyList,
  PasskeyRegistrationResponse,
  PasskeySignInRequest,
  Project,
  ProjectList,
  PublicConfig,
  PublishResult,
  PublishTargetInput,
  PublishWarning,
  page,
  RenamePasskeyRequest,
  SetupPasskeyOptionsRequest,
  SetupRequest,
  UpdateProfileRequest,
  UpdateProjectRequest,
  VersionSummary,
} from '@pinwall/shared';
