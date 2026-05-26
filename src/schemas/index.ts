import { z } from 'zod'

// ----------------------------------------------------------------
// Auth
// ----------------------------------------------------------------
export const SetupSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})

export const SignupSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  base_currency: z.string().default('INR'),
})

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export const ForgotPasswordSchema = z.object({
  email: z.string().email(),
})

export const VerifyOtpSchema = z.object({
  email: z.string().email(),
  otp: z.string().min(1),
})

export const ResetPasswordSchema = z.object({
  reset_token: z.string().min(1),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})

// ----------------------------------------------------------------
// Profile
// ----------------------------------------------------------------
export const UpdateProfileSchema = z.object({
  name: z.string().min(1).optional(),
  base_currency: z.string().min(1).optional(),
})

export const ChangePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8, 'New password must be at least 8 characters'),
})

// ----------------------------------------------------------------
// Holdings
// ----------------------------------------------------------------
export const CreateHoldingSchema = z.object({
  asset_id: z.string().uuid(),
  custom_name: z.string().min(1).optional(),
  unit_label: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  remarks: z.string().optional(),
})

export const UpdateHoldingSchema = z.object({
  custom_name: z.string().min(1).optional(),
  unit_label: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  remarks: z.string().optional(),
  status: z.string().optional(),
})

// ----------------------------------------------------------------
// Lots
// ----------------------------------------------------------------
export const CreateLotSchema = z.object({
  transaction_type: z.enum(['buy', 'sell']),
  quantity: z.string().regex(/^\d+(\.\d+)?$/, 'quantity must be a positive number'),
  price_per_unit: z.string().regex(/^\d+(\.\d+)?$/, 'price_per_unit must be a positive number'),
  transaction_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'transaction_date must be YYYY-MM-DD'),
  notes: z.string().optional(),
})

// ----------------------------------------------------------------
// Holding values
// ----------------------------------------------------------------
export const CreateHoldingValueSchema = z.object({
  value: z.string().regex(/^\d+(\.\d+)?$/, 'value must be a positive number'),
  recorded_at: z.string().optional(),
  notes: z.string().optional(),
})

// ----------------------------------------------------------------
// Connections
// ----------------------------------------------------------------
export const ConnectionRequestSchema = z.object({
  profile_code: z.string().min(1),
})

export const ApproveConnectionSchema = z.object({
  access_level: z.enum(['view', 'edit']),
})

export const FamilyToggleSchema = z.object({
  include_in_family: z.boolean(),
})

// ----------------------------------------------------------------
// Admin - invitations
// ----------------------------------------------------------------
export const CreateInvitationSchema = z.object({
  label: z.string().optional(),
  email: z.string().email().optional(),
  send_email: z.boolean().default(false),
})

// ----------------------------------------------------------------
// Admin - assets
// ----------------------------------------------------------------
export const CreateAssetSchema = z.object({
  name: z.string().min(1),
  currency: z.string().min(1),
  unit_type: z.string().min(1),
  update_mode: z.string().min(1),
  data_type: z.string().optional(),
  symbol: z.string().optional(),
  cost_basis_mode: z.string().min(1),
  locked_unit_cost: z.string().optional(),
})

export const UpdateAssetSchema = z.object({
  name: z.string().min(1).optional(),
  currency: z.string().min(1).optional(),
  data_type: z.string().optional(),
  symbol: z.string().optional(),
})

// ----------------------------------------------------------------
// Admin - notifications
// ----------------------------------------------------------------
export const UpdateRoutingSchema = z.object({
  is_active: z.boolean(),
})
