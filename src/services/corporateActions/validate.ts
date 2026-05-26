import { logger } from '../../lib/logger'
import { emit } from '../notifications'
import { CorporateAction, AssetAlias } from './types'
import { WeeklyPrice } from './yahoo'
import { MfNav } from './mfapi'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const SYMBOL_CHARS = /^[A-Z0-9&.-]+$/i
const MIN_DATE = '1900-01-01'

function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false
  const d = new Date(s)
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

function isNotFuture(s: string): boolean {
  return s <= new Date().toISOString().slice(0, 10)
}

function isNotTooOld(s: string): boolean {
  return s >= MIN_DATE
}

type ValidationFailure = {
  field: string
  value: unknown
  reason: string
}

function fail(field: string, value: unknown, reason: string): ValidationFailure {
  return { field, value, reason }
}

function validateCorporateAction(a: CorporateAction, index: number): ValidationFailure[] {
  const errs: ValidationFailure[] = []
  const prefix = `actions[${index}]`

  const validTypes = ['split', 'bonus', 'merger', 'delisting']
  if (!validTypes.includes(a.action_type)) {
    errs.push(fail(`${prefix}.action_type`, a.action_type, `must be one of: ${validTypes.join(', ')}`))
  }

  if (!a.action_date || typeof a.action_date !== 'string') {
    errs.push(fail(`${prefix}.action_date`, a.action_date, 'missing or not a string'))
  } else if (!isValidIsoDate(a.action_date)) {
    errs.push(fail(`${prefix}.action_date`, a.action_date, 'not a valid YYYY-MM-DD date'))
  } else if (!isNotFuture(a.action_date)) {
    errs.push(fail(`${prefix}.action_date`, a.action_date, 'date is in the future'))
  } else if (!isNotTooOld(a.action_date)) {
    errs.push(fail(`${prefix}.action_date`, a.action_date, `date is before ${MIN_DATE}`))
  }

  if (a.action_type === 'split' || a.action_type === 'bonus') {
    if (a.ratio_from == null || a.ratio_to == null) {
      errs.push(fail(`${prefix}.ratio`, `${a.ratio_from}:${a.ratio_to}`, 'ratio_from and ratio_to are required for split/bonus'))
    } else {
      if (!Number.isFinite(a.ratio_from) || a.ratio_from <= 0) {
        errs.push(fail(`${prefix}.ratio_from`, a.ratio_from, 'must be a positive finite number'))
      }
      if (!Number.isFinite(a.ratio_to) || a.ratio_to <= 0) {
        errs.push(fail(`${prefix}.ratio_to`, a.ratio_to, 'must be a positive finite number'))
      }
      if (a.ratio_from != null && a.ratio_to != null && a.ratio_to <= a.ratio_from) {
        errs.push(fail(`${prefix}.ratio`, `${a.ratio_from}:${a.ratio_to}`, 'ratio_to must be greater than ratio_from (splits and bonuses always increase share count)'))
      }
    }
  }

  return errs
}

function validateAssetAlias(a: AssetAlias, index: number): ValidationFailure[] {
  const errs: ValidationFailure[] = []
  const prefix = `aliases[${index}]`

  if (!a.symbol || typeof a.symbol !== 'string' || a.symbol.trim() === '') {
    errs.push(fail(`${prefix}.symbol`, a.symbol, 'symbol is empty'))
  } else if (!SYMBOL_CHARS.test(a.symbol.trim())) {
    errs.push(fail(`${prefix}.symbol`, a.symbol, 'symbol contains unexpected characters - expected letters, digits, &, ., -'))
  }

  if (!a.name || typeof a.name !== 'string' || a.name.trim() === '') {
    // empty name is allowed for symbol-only changes - caller should fill it in from other sources
    logger.warn(`[corporateActions] ${prefix}.name is empty for symbol ${a.symbol} - will need to be filled from name change records or current asset`)
  }

  if (!a.from_date || typeof a.from_date !== 'string') {
    errs.push(fail(`${prefix}.from_date`, a.from_date, 'missing or not a string'))
  } else if (!isValidIsoDate(a.from_date)) {
    errs.push(fail(`${prefix}.from_date`, a.from_date, 'not a valid YYYY-MM-DD date'))
  } else if (!isNotTooOld(a.from_date)) {
    errs.push(fail(`${prefix}.from_date`, a.from_date, `date is before ${MIN_DATE}`))
  }

  if (a.to_date !== null) {
    if (typeof a.to_date !== 'string') {
      errs.push(fail(`${prefix}.to_date`, a.to_date, 'must be a string or null'))
    } else if (!isValidIsoDate(a.to_date)) {
      errs.push(fail(`${prefix}.to_date`, a.to_date, 'not a valid YYYY-MM-DD date'))
    } else if (!isNotFuture(a.to_date)) {
      errs.push(fail(`${prefix}.to_date`, a.to_date, 'to_date is in the future'))
    } else if (a.from_date && a.to_date <= a.from_date) {
      errs.push(fail(`${prefix}.to_date`, a.to_date, `to_date (${a.to_date}) must be after from_date (${a.from_date})`))
    }
  }

  return errs
}

function validateWeeklyPrice(p: WeeklyPrice, index: number): ValidationFailure[] {
  const errs: ValidationFailure[] = []
  const prefix = `prices[${index}]`

  if (!p.price_date || !isValidIsoDate(p.price_date)) {
    errs.push(fail(`${prefix}.price_date`, p.price_date, 'not a valid YYYY-MM-DD date'))
  } else if (!isNotFuture(p.price_date)) {
    errs.push(fail(`${prefix}.price_date`, p.price_date, 'date is in the future'))
  } else if (!isNotTooOld(p.price_date)) {
    errs.push(fail(`${prefix}.price_date`, p.price_date, `date is before ${MIN_DATE}`))
  }

  if (!Number.isFinite(p.close) || p.close <= 0) {
    errs.push(fail(`${prefix}.close`, p.close, 'must be a positive finite number'))
  }

  return errs
}

function validateMfNav(n: MfNav, index: number): ValidationFailure[] {
  const errs: ValidationFailure[] = []
  const prefix = `navs[${index}]`

  if (!n.price_date || !isValidIsoDate(n.price_date)) {
    errs.push(fail(`${prefix}.price_date`, n.price_date, 'not a valid YYYY-MM-DD date'))
  } else if (!isNotFuture(n.price_date)) {
    errs.push(fail(`${prefix}.price_date`, n.price_date, 'date is in the future'))
  } else if (!isNotTooOld(n.price_date)) {
    errs.push(fail(`${prefix}.price_date`, n.price_date, `date is before ${MIN_DATE}`))
  }

  if (!Number.isFinite(n.nav) || n.nav <= 0) {
    errs.push(fail(`${prefix}.nav`, n.nav, 'must be a positive finite number'))
  }

  return errs
}

async function alertAndThrow(symbol: string, context: string, failures: ValidationFailure[]): Promise<never> {
  const lines = failures.map(f => `  - ${f.field}: got ${JSON.stringify(f.value)} -> ${f.reason}`)
  logger.error(`[corporateActions] validation failed (${context}):\n${lines.join('\n')}`)
  emit('CORPORATE_ACTION_VALIDATION_FAILED', {
    symbol,
    context,
    failures: lines.join('\n'),
  })
  throw new Error(`Validation failed: ${context}`)
}

export async function validateCorporateActions(actions: CorporateAction[], symbol: string, context: string): Promise<CorporateAction[]> {
  const allFailures: ValidationFailure[] = []
  const valid: CorporateAction[] = []

  for (let i = 0; i < actions.length; i++) {
    const errs = validateCorporateAction(actions[i], i)
    if (errs.length > 0) allFailures.push(...errs)
    else valid.push(actions[i])
  }

  if (allFailures.length > 0) {
    await alertAndThrow(symbol, context, allFailures)
  }

  return valid
}

export async function validateAssetAliases(aliases: AssetAlias[], symbol: string, context: string): Promise<AssetAlias[]> {
  const allFailures: ValidationFailure[] = []
  const valid: AssetAlias[] = []

  for (let i = 0; i < aliases.length; i++) {
    const errs = validateAssetAlias(aliases[i], i)
    if (errs.length > 0) allFailures.push(...errs)
    else valid.push(aliases[i])
  }

  if (allFailures.length > 0) {
    await alertAndThrow(symbol, context, allFailures)
  }

  return valid
}

export async function validateWeeklyPrices(prices: WeeklyPrice[], symbol: string, context: string): Promise<WeeklyPrice[]> {
  const failures: ValidationFailure[] = []
  const valid: WeeklyPrice[] = []

  for (let i = 0; i < prices.length; i++) {
    const errs = validateWeeklyPrice(prices[i], i)
    if (errs.length > 0) failures.push(...errs)
    else valid.push(prices[i])
  }

  if (failures.length > 0) {
    await alertAndThrow(symbol, context, failures)
  }

  return valid
}

export async function validateMfNavHistory(navs: MfNav[], symbol: string, context: string): Promise<MfNav[]> {
  const failures: ValidationFailure[] = []
  const valid: MfNav[] = []

  for (let i = 0; i < navs.length; i++) {
    const errs = validateMfNav(navs[i], i)
    if (errs.length > 0) failures.push(...errs)
    else valid.push(navs[i])
  }

  if (failures.length > 0) {
    await alertAndThrow(symbol, context, failures)
  }

  return valid
}
