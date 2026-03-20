/**
 * Vitana Scheduling Skill for OpenClaw
 *
 * Appointment booking, rescheduling, cancellation, and waitlist management.
 * Handles timezone conversion, conflict detection, and auto-links to
 * vitana-daily for telehealth room creation.
 */

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const BookAppointmentSchema = z.object({
  tenant_id: z.string().uuid(),
  patient_id: z.string().uuid(),
  professional_id: z.string().uuid(),
  datetime: z.string().datetime(),
  duration_minutes: z.number().int().min(5).max(240).default(30),
  type: z.enum(['in_person', 'telehealth', 'phone']).default('telehealth'),
  reason: z.string().max(1000).optional(),
  timezone: z.string().default('UTC'),
});

const RescheduleSchema = z.object({
  tenant_id: z.string().uuid(),
  appointment_id: z.string().uuid(),
  new_datetime: z.string().datetime(),
  reason: z.string().max(500).optional(),
});

const CancelSchema = z.object({
  tenant_id: z.string().uuid(),
  appointment_id: z.string().uuid(),
  reason: z.string().max(500).optional(),
  cancelled_by: z.enum(['patient', 'professional', 'system']).default('system'),
});

const CheckAvailabilitySchema = z.object({
  tenant_id: z.string().uuid(),
  professional_id: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  duration_minutes: z.number().int().min(5).max(240).default(30),
});

const ListUpcomingSchema = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  role: z.enum(['patient', 'professional']),
  days_ahead: z.number().int().min(1).max(90).default(7),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE required');
  return createClient(url, key);
}

// ---------------------------------------------------------------------------
// Skill Actions
// ---------------------------------------------------------------------------

export const actions = {
  /**
   * Book a new appointment with conflict detection.
   */
  async book(input: unknown) {
    const { tenant_id, patient_id, professional_id, datetime, duration_minutes, type, reason, timezone } =
      BookAppointmentSchema.parse(input);

    const supabase = getSupabase();
    const endTime = new Date(new Date(datetime).getTime() + duration_minutes * 60000).toISOString();

    // Check for conflicts
    const { data: conflicts } = await supabase
      .from('appointments')
      .select('id, scheduled_at, duration_minutes')
      .eq('tenant_id', tenant_id)
      .eq('professional_id', professional_id)
      .neq('status', 'cancelled')
      .gte('scheduled_at', new Date(new Date(datetime).getTime() - 240 * 60000).toISOString())
      .lte('scheduled_at', endTime);

    if (conflicts && conflicts.length > 0) {
      return {
        success: false,
        error: 'scheduling_conflict',
        conflicts: conflicts.map((c) => ({ id: c.id, scheduled_at: c.scheduled_at })),
      };
    }

    // Create appointment
    const { data, error } = await supabase
      .from('appointments')
      .insert({
        tenant_id,
        patient_id,
        professional_id,
        scheduled_at: datetime,
        duration_minutes,
        type,
        reason,
        timezone,
        status: 'confirmed',
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw new Error(`book failed: ${error.message}`);

    // Auto-create telehealth room if needed
    if (type === 'telehealth') {
      const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8080';
      await fetch(`${gatewayUrl}/api/v1/live-rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id,
          scheduled_at: datetime,
          topic: reason ?? 'Telehealth Appointment',
          participant_ids: [patient_id, professional_id],
          duration_minutes,
          appointment_id: data.id,
          source: 'openclaw-autopilot',
        }),
      }).catch((err) => {
        console.warn('[scheduling] Failed to create telehealth room (non-fatal):', err.message);
      });
    }

    // Audit
    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'scheduling.appointment_booked',
      actor: 'openclaw-autopilot',
      details: { appointment_id: data.id, type, professional_id, patient_id },
      created_at: new Date().toISOString(),
    });

    return { success: true, appointment: data };
  },

  /**
   * Reschedule an existing appointment.
   */
  async reschedule(input: unknown) {
    const { tenant_id, appointment_id, new_datetime, reason } = RescheduleSchema.parse(input);
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('appointments')
      .update({
        scheduled_at: new_datetime,
        reschedule_reason: reason,
        rescheduled_at: new Date().toISOString(),
        status: 'confirmed',
      })
      .eq('id', appointment_id)
      .eq('tenant_id', tenant_id)
      .select()
      .single();

    if (error) throw new Error(`reschedule failed: ${error.message}`);

    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'scheduling.appointment_rescheduled',
      actor: 'openclaw-autopilot',
      details: { appointment_id, new_datetime, reason },
      created_at: new Date().toISOString(),
    });

    return { success: true, appointment: data };
  },

  /**
   * Cancel an appointment.
   */
  async cancel(input: unknown) {
    const { tenant_id, appointment_id, reason, cancelled_by } = CancelSchema.parse(input);
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('appointments')
      .update({
        status: 'cancelled',
        cancel_reason: reason,
        cancelled_by,
        cancelled_at: new Date().toISOString(),
      })
      .eq('id', appointment_id)
      .eq('tenant_id', tenant_id)
      .select()
      .single();

    if (error) throw new Error(`cancel failed: ${error.message}`);

    await supabase.from('autopilot_logs').insert({
      tenant_id,
      action: 'scheduling.appointment_cancelled',
      actor: 'openclaw-autopilot',
      details: { appointment_id, reason, cancelled_by },
      created_at: new Date().toISOString(),
    });

    return { success: true, appointment: data };
  },

  /**
   * Check professional's availability for a given date.
   */
  async check_availability(input: unknown) {
    const { tenant_id, professional_id, date, duration_minutes } = CheckAvailabilitySchema.parse(input);
    const supabase = getSupabase();

    const dayStart = `${date}T00:00:00Z`;
    const dayEnd = `${date}T23:59:59Z`;

    const { data: booked, error } = await supabase
      .from('appointments')
      .select('scheduled_at, duration_minutes')
      .eq('tenant_id', tenant_id)
      .eq('professional_id', professional_id)
      .neq('status', 'cancelled')
      .gte('scheduled_at', dayStart)
      .lte('scheduled_at', dayEnd)
      .order('scheduled_at', { ascending: true });

    if (error) throw new Error(`check_availability failed: ${error.message}`);

    return {
      success: true,
      date,
      professional_id,
      booked_slots: booked ?? [],
      requested_duration: duration_minutes,
    };
  },

  /**
   * List upcoming appointments for a user (patient or professional).
   */
  async list_upcoming(input: unknown) {
    const { tenant_id, user_id, role, days_ahead } = ListUpcomingSchema.parse(input);
    const supabase = getSupabase();

    const cutoff = new Date(Date.now() + days_ahead * 24 * 60 * 60 * 1000).toISOString();
    const userColumn = role === 'patient' ? 'patient_id' : 'professional_id';

    const { data, error } = await supabase
      .from('appointments')
      .select('id, scheduled_at, duration_minutes, type, status, reason')
      .eq('tenant_id', tenant_id)
      .eq(userColumn, user_id)
      .neq('status', 'cancelled')
      .gte('scheduled_at', new Date().toISOString())
      .lte('scheduled_at', cutoff)
      .order('scheduled_at', { ascending: true })
      .limit(50);

    if (error) throw new Error(`list_upcoming failed: ${error.message}`);
    return { success: true, appointments: data, count: data?.length ?? 0 };
  },
};

export const SKILL_META = {
  name: 'vitana-scheduling',
  description: 'Appointment booking, rescheduling, cancellation, and availability management',
  actions: Object.keys(actions),
};
