import { defineConfig, stores } from '@adonis-agora/authz'
import { resolveAppRoles, resolveAppRoleMembers } from '#agent/user_roles'

/**
 * authz is used ONLY as the agent's authorizer. The source of truth for roles is still
 * `entretextos.user_roles`: nothing is seeded into the `authz_*` tables.
 *
 * The lucid store on the `entretextos` connection exists because the provider requires
 * it; it sits idle (no role/permission is seeded). The lib manages its own tables:
 * `autoCreateSchema` defaults to `true`, so on the first check it runs
 * `CREATE TABLE IF NOT EXISTS authz_*` on the `entretextos` connection.
 */
export default defineConfig({
  default: 'lucid',
  stores: {
    lucid: stores.lucid({ connection: 'entretextos' }),
  },
  resolveRoles: async (user) => resolveAppRoles(String(user.id)),
  resolveRoleMembers: (role) => resolveAppRoleMembers(role),
  roleGrants: {
    ADMIN: ['agent.*'],
  },
})
