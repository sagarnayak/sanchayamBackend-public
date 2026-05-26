export interface AuthUser {
  id: string
  isMasterAdmin: boolean
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser
  }
}
