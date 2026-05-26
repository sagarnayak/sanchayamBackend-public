import crypto from 'crypto'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { env } from '../config/env'

const BCRYPT_ROUNDS = 12

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS)
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function generateSecureToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex')
}

export function generateOtp(): string {
  const digits = crypto.randomBytes(4).readUInt32BE(0) % 1000000
  return digits.toString().padStart(6, '0')
}

export function generateProfileCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const b = crypto.randomBytes(7)
  const l = (i: number) => letters[b[i] % letters.length]
  return `${l(0)}${l(1)}${l(2)}-${b[3] % 10}${b[4] % 10}${b[5] % 10}${b[6] % 10}`
}

export function signAccessToken(userId: string, isMasterAdmin: boolean): string {
  return jwt.sign(
    { sub: userId, adm: isMasterAdmin },
    env.JWT_SECRET,
    { expiresIn: '15m' }
  )
}

export function signResetToken(userId: string): string {
  return jwt.sign(
    { sub: userId, purpose: 'password_reset' },
    env.JWT_SECRET,
    { expiresIn: '15m' }
  )
}

export function verifyAccessToken(token: string): { sub: string; adm: boolean; iat: number } {
  return jwt.verify(token, env.JWT_SECRET) as { sub: string; adm: boolean; iat: number }
}

export function verifyResetToken(token: string): { sub: string; purpose: string } {
  return jwt.verify(token, env.JWT_SECRET) as { sub: string; purpose: string }
}
