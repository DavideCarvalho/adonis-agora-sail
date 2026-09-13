export const VERSION = '0.2.2';

// Re-exported here (not just via the `./configure` subpath) because `ace
// configure` / `ace add` import the package root and look for a `configure`
// hook on it. `configure.ts` only imports `type Configure`, so this adds no
// runtime dependency on `@adonisjs/core` — the main entrypoint stays
// framework-free.
export { configure } from '../configure.js';

export {
  AGENTS_MD_END,
  AGENTS_MD_START,
  buildAgentsMdSection,
  upsertAgentsMd,
} from './agents_md.js';
export type {
  AgoraSignal,
  AppScan,
  AppScanInput,
  DbClient,
  ServiceEvidence,
  ServiceEvidenceVia,
} from './app_scan.js';
export {
  ENV_VALIDATIONS,
  formatAppScan,
  MINIO_SETUP_NOTE,
  mergeServices,
  parseDbClient,
  parseEnvGets,
  parseEnvTsKeys,
  scanAppConfig,
  scanAppFiles,
  stripComments,
  stripLineComment,
} from './app_scan.js';
export type { CertPaths } from './certs.js';
export {
  buildTlsConfig,
  certPaths,
  checkMkcert,
  expandCertHostnames,
  isCaInstalled,
  issueCert,
  MKCERT_CA_INSTALL_HINT,
  MKCERT_INSTALL_HINT,
} from './certs.js';
export { generateComposeFile, mergeComposeFile, servicesInComposeFile } from './compose_file.js';
export { buildSailContext, resolveSailContext, sanitizeProjectName } from './context.js';
export type { DbShellService } from './db_shell.js';
export { DB_SHELL_SERVICES, dbShellCommand, dbShellExample } from './db_shell.js';
export { detectServices, detectServicesFromDependencies } from './detect.js';
export type { RunResult } from './docker.js';
export { DockerCompose, findTakenPorts, parsePortHolders, parsePsEntries } from './docker.js';
export type { LocalEnvFileSync, SailLocalSyncResult } from './dotenv.js';
export {
  DOTENV_EXAMPLE_FILE_NAME,
  DOTENV_FILE_NAME,
  dotenvKeysPresent,
  encryptedEnvWarning,
  readDotEnvKeySets,
  syncSailLocalEnvs,
  TEST_LOCAL_ENV_FILE_NAME,
  upsertDotEnvKeys,
} from './dotenv.js';
export type { SailServiceInfo, SailStackInfo } from './info.js';
export {
  buildStackInfo,
  formatAppEnv,
  formatStackInfo,
  resolveStackInfo,
} from './info.js';
export { computeWorktreePortOffset, PORT_RANGE, resolveHostPorts } from './ports.js';
export type { ProxyPaths } from './proxy.js';
export {
  buildRouteConfig,
  DEFAULT_DOMAIN_SUFFIXES,
  generateProxyComposeFile,
  hostnamesFor,
  listRegisteredProjects,
  PROXY_PROJECT_NAME,
  proxyPaths,
  routeConfigPath,
  sailHomeDir,
} from './proxy.js';
export {
  DOMAIN_ENV_KEY,
  ensureProxyScaffold,
  hasIssuedCert,
  isDomainEnabled,
  normalizeHostname,
  proxyContext,
  refreshTlsConfig,
  removeRoute,
  resolveDomainHostnames,
  resolvesLocally,
  TLS_CONFIG_FILE_NAME,
  writeRoute,
} from './proxy_state.js';
export type { ComposeProject } from './prune.js';
export {
  findOrphanProjects,
  isManagedProject,
  parseComposeProjects,
} from './prune.js';
export { resolverInstructions, resolverSupported } from './resolver.js';
export {
  isServiceName,
  SAIL_DATABASE,
  SAIL_PASSWORD,
  SAIL_USER,
  SERVICE_NAMES,
  SERVICES,
} from './services.js';
export {
  CLOUDFLARED_INSTALL_HINT,
  checkCloudflared,
  DEFAULT_APP_PORT,
  dotEnvCandidates,
  isPortOpen,
  parseDotEnvPort,
  parseTunnelUrl,
  resolveSharePort,
  SHARE_URL_TIMEOUT_MS,
  selectShareTarget,
} from './share.js';
export type {
  SailContext,
  SailPortDefinition,
  SailServiceDefinition,
  SailServiceName,
  SailServiceStatus,
} from './types.js';
export type {
  AuditPatternsAction,
  SailEnvSyncResult,
  SchemaSectionResult,
  VarlockDetection,
} from './varlock.js';
export {
  AUDIT_EXTRA_PATTERNS_LINES,
  AUDIT_EXTRA_PATTERNS_NOTE,
  baseAppEnv,
  buildSailEnvBlock,
  buildSchemaSection,
  detectVarlock,
  ensureAuditExtraPatterns,
  ensureGitignoreEntry,
  ensureSchemaSection,
  GITIGNORE_FILE_NAME,
  hasAuditExtraPatterns,
  isEncryptedEnvContent,
  LOCAL_ENV_FILE_NAME,
  SAIL_ENV_END,
  SAIL_ENV_START,
  SAIL_SCHEMA_END,
  SAIL_SCHEMA_START,
  SCHEMA_FILE_NAME,
  SCHEMA_ROOT_DIVIDER,
  sailEnvKeys,
  syncSailLocalEnv,
  upsertSailEnvBlock,
} from './varlock.js';
