/**
 * VTID-04674: the catalog of every notification type the platform can send.
 *
 * The admin screen lists these, grouped by who receives them, each with an
 * on/off switch (state lives in notification_type_controls). A type that is
 * sent but missing here still appears on the screen — it is auto-registered
 * as OFF by the database guard the first time something tries to send it —
 * with its raw type name until an entry is added below.
 *
 * `text`:
 *   'ready'         — the sender writes the text in the member's language.
 *   'not_localized' — the sender writes English only. The switch refuses to
 *                     turn it on until the text is translated (CLAUDE.md §13b).
 *   'unverified'    — nobody has checked yet. Can be turned on; the screen
 *                     says it was not checked.
 */

export type NotificationAudience = 'member' | 'admin' | 'developer' | 'staff';
export type NotificationTrigger = 'member_activity' | 'scheduled' | 'automation' | 'system';
export type TextReadiness = 'ready' | 'not_localized' | 'unverified';

export interface NotificationCatalogEntry {
  type: string;
  audience: NotificationAudience;
  group: string;
  trigger: NotificationTrigger;
  text: TextReadiness;
  label: { en: string; de: string };
  description: { en: string; de: string };
}

type Row = [
  type: string, audience: NotificationAudience, group: string, trigger: NotificationTrigger,
  text: TextReadiness, labelEn: string, labelDe: string, descEn: string, descDe: string,
];

const ROWS: Row[] = [
  // ── Posts & reactions (database triggers) ─────────────────────────────────
  ['community_post_published', 'member', 'posts', 'member_activity', 'ready', 'New community post', 'Neuer Community-Beitrag', 'Someone in the community published a post or video.', 'Jemand in der Community hat einen Beitrag oder ein Video veröffentlicht.'],
  ['post_like', 'member', 'posts', 'member_activity', 'ready', 'Like on your post', 'Like auf deinen Beitrag', 'Someone liked your post.', 'Jemand hat deinen Beitrag geliked.'],
  ['post_comment', 'member', 'posts', 'member_activity', 'ready', 'Comment on your post', 'Kommentar zu deinem Beitrag', 'Someone commented on your post.', 'Jemand hat deinen Beitrag kommentiert.'],
  ['comment_like', 'member', 'posts', 'member_activity', 'ready', 'Like on your comment', 'Like auf deinen Kommentar', 'Someone liked your comment.', 'Jemand hat deinen Kommentar geliked.'],
  ['comment_reply', 'member', 'posts', 'member_activity', 'ready', 'Reply to your comment', 'Antwort auf deinen Kommentar', 'Someone replied to your comment.', 'Jemand hat auf deinen Kommentar geantwortet.'],
  ['post_mention', 'member', 'posts', 'member_activity', 'ready', 'You were mentioned', 'Du wurdest erwähnt', 'Someone mentioned you in a post.', 'Jemand hat dich in einem Beitrag erwähnt.'],
  ['new_follower', 'member', 'posts', 'member_activity', 'ready', 'New follower', 'Neuer Follower', 'Someone started following you.', 'Jemand folgt dir jetzt.'],

  // ── Chat ──────────────────────────────────────────────────────────────────
  ['new_chat_message', 'member', 'chat', 'member_activity', 'ready', 'New chat message', 'Neue Chat-Nachricht', 'A person or group sent you a message.', 'Eine Person oder Gruppe hat dir geschrieben.'],
  ['message_reaction', 'member', 'chat', 'member_activity', 'ready', 'Reaction to your message', 'Reaktion auf deine Nachricht', 'Someone reacted to your chat message.', 'Jemand hat auf deine Chat-Nachricht reagiert.'],
  ['listing_interest', 'member', 'chat', 'member_activity', 'unverified', 'Interest in your listing', 'Interesse an deinem Angebot', 'A buyer messaged you about your marketplace listing.', 'Jemand hat dir zu deinem Marktplatz-Angebot geschrieben.'],

  // ── ORB (Vitana's own messages) ───────────────────────────────────────────
  ['orb_proactive_message', 'member', 'orb', 'automation', 'unverified', 'Message from Vitana', 'Nachricht von Vitana', 'Vitana reaches out on her own, sent by an automation.', 'Vitana meldet sich von sich aus, ausgelöst durch eine Automation.'],
  ['orb_suggestion', 'member', 'orb', 'automation', 'unverified', 'Suggestion from Vitana', 'Vorschlag von Vitana', 'A suggestion from Vitana, sent by an automation.', 'Ein Vorschlag von Vitana, ausgelöst durch eine Automation.'],
  ['conversation_followup_reminder', 'member', 'orb', 'automation', 'unverified', 'Follow up a conversation', 'Gespräch fortsetzen', 'A reminder to continue a conversation.', 'Eine Erinnerung, ein Gespräch fortzusetzen.'],
  ['reminder_due', 'member', 'orb', 'member_activity', 'ready', 'Reminder the member set', 'Selbst gesetzte Erinnerung', 'A reminder the member asked Vitana to set.', 'Eine Erinnerung, die das Mitglied bei Vitana eingestellt hat.'],

  // ── Daily & weekly (scheduled) ────────────────────────────────────────────
  ['feature_announcement', 'member', 'scheduled', 'scheduled', 'ready', 'Daily tip / feature announcement', 'Täglicher Tipp / Neuigkeit', 'The daily tip about a Vitanaland feature, or an announcement.', 'Der tägliche Tipp zu einer Vitanaland-Funktion oder eine Ankündigung.'],
  ['morning_briefing_ready', 'member', 'scheduled', 'scheduled', 'ready', 'Morning briefing', 'Morgen-Briefing', 'Every morning: a personal summary of the day.', 'Jeden Morgen: eine persönliche Zusammenfassung des Tages.'],
  ['daily_pace_check', 'member', 'scheduled', 'scheduled', 'ready', 'Evening pace check', 'Abendlicher Tages-Check', 'At 19:00 local time: how the day went against the plan.', 'Um 19:00 Ortszeit: wie der Tag im Vergleich zum Plan lief.'],
  ['daily_diary_reminder', 'member', 'scheduled', 'scheduled', 'ready', 'Diary reminder', 'Tagebuch-Erinnerung', 'Every evening: a reminder to write in the diary.', 'Jeden Abend: eine Erinnerung ans Tagebuch.'],
  ['day_close_push', 'member', 'scheduled', 'scheduled', 'ready', 'Good-night message', 'Gute-Nacht-Nachricht', 'At 22:00 local time: a short close of the day.', 'Um 22:00 Ortszeit: ein kurzer Tagesabschluss.'],
  ['weekly_community_digest', 'member', 'scheduled', 'scheduled', 'ready', 'Weekly community digest', 'Wöchentlicher Community-Überblick', 'Sunday: what happened in the community this week.', 'Sonntag: was diese Woche in der Community passiert ist.'],
  ['weekly_activity_summary', 'member', 'scheduled', 'scheduled', 'ready', 'Weekly activity summary', 'Wöchentliche Aktivitäts-Zusammenfassung', 'A summary of the member\'s own week.', 'Eine Zusammenfassung der eigenen Woche.'],
  ['weekly_reflection_prompt', 'member', 'scheduled', 'scheduled', 'ready', 'Weekly reflection', 'Wöchentliche Reflexion', 'Friday: an invitation to reflect on the week.', 'Freitag: eine Einladung, über die Woche nachzudenken.'],
  ['upcoming_event_today', 'member', 'scheduled', 'scheduled', 'ready', 'Event today', 'Event heute', 'Morning notice about the member\'s event today.', 'Morgens: Hinweis auf das heutige Event des Mitglieds.'],
  ['recommendation_expires_soon', 'member', 'scheduled', 'scheduled', 'unverified', 'Recommendation expires soon', 'Empfehlung läuft bald ab', 'An activated recommendation is about to expire.', 'Eine aktivierte Empfehlung läuft bald ab.'],
  ['signal_expired', 'member', 'scheduled', 'scheduled', 'unverified', 'Signal expired (silent)', 'Signal abgelaufen (still)', 'Silent: a health signal expired.', 'Still: ein Gesundheitssignal ist abgelaufen.'],
  ['daily_recompute_complete', 'member', 'scheduled', 'system', 'unverified', 'Daily recompute done (silent)', 'Tägliche Neuberechnung fertig (still)', 'Silent: the nightly recompute finished.', 'Still: die nächtliche Neuberechnung ist fertig.'],

  // ── Matches & connections ─────────────────────────────────────────────────
  ['new_daily_matches', 'member', 'matches', 'automation', 'unverified', 'New daily matches', 'Neue Matches des Tages', 'New people matched for the member today.', 'Heute neu passende Personen für das Mitglied.'],
  ['person_match_suggested', 'member', 'matches', 'automation', 'unverified', 'Person suggested', 'Person vorgeschlagen', 'A person who could be a good connection.', 'Eine Person, die gut passen könnte.'],
  ['group_match_suggested', 'member', 'matches', 'member_activity', 'unverified', 'Group suggested', 'Gruppe vorgeschlagen', 'A group that fits the member.', 'Eine Gruppe, die zum Mitglied passt.'],
  ['event_match_suggested', 'member', 'matches', 'automation', 'unverified', 'Event suggested', 'Event vorgeschlagen', 'An event that fits the member.', 'Ein Event, das zum Mitglied passt.'],
  ['live_room_match_suggested', 'member', 'matches', 'member_activity', 'unverified', 'Live room suggested', 'Live-Room vorgeschlagen', 'A live room that fits the member.', 'Ein Live-Room, der zum Mitglied passt.'],
  ['match_accepted_by_other', 'member', 'matches', 'member_activity', 'unverified', 'Your match accepted', 'Match angenommen', 'Someone accepted the member\'s match.', 'Jemand hat das Match angenommen.'],
  ['your_match_accepted', 'member', 'matches', 'member_activity', 'unverified', 'Match confirmed', 'Match bestätigt', 'Both sides accepted the match.', 'Beide Seiten haben das Match angenommen.'],
  ['new_connection_formed', 'member', 'matches', 'member_activity', 'unverified', 'New connection', 'Neue Verbindung', 'A new connection was formed.', 'Eine neue Verbindung ist entstanden.'],
  ['relationship_strength_increased', 'member', 'matches', 'system', 'unverified', 'Connection grew stronger', 'Verbindung gestärkt', 'A connection became stronger.', 'Eine Verbindung ist stärker geworden.'],
  ['someone_wants_to_connect', 'member', 'matches', 'member_activity', 'unverified', 'Someone wants to connect', 'Jemand möchte sich verbinden', 'Someone asked to connect.', 'Jemand möchte sich verbinden.'],
  ['people_near_you', 'member', 'matches', 'automation', 'unverified', 'People near you', 'Menschen in deiner Nähe', 'Members nearby.', 'Mitglieder in der Nähe.'],
  ['comfort_boundary_respected', 'member', 'matches', 'system', 'unverified', 'Boundary respected (silent)', 'Grenze respektiert (still)', 'Silent bookkeeping.', 'Stille Buchführung.'],
  ['group_social_proof', 'member', 'matches', 'automation', 'not_localized', 'Friends in a group', 'Freunde in einer Gruppe', 'People the member knows joined a group.', 'Bekannte sind einer Gruppe beigetreten.'],
  ['opportunity_social_layer', 'member', 'matches', 'automation', 'not_localized', 'Opportunity with friends', 'Gelegenheit mit Bekannten', 'An opportunity people the member knows are taking.', 'Eine Gelegenheit, die Bekannte wahrnehmen.'],

  // ── Groups & community ────────────────────────────────────────────────────
  ['someone_joined_your_group', 'member', 'community', 'member_activity', 'unverified', 'Someone joined your group', 'Jemand ist deiner Gruppe beigetreten', 'A new member joined a group the member created.', 'Ein neues Mitglied ist einer eigenen Gruppe beigetreten.'],
  ['new_member_in_group', 'member', 'community', 'member_activity', 'unverified', 'New member in a group', 'Neues Mitglied in einer Gruppe', 'Someone joined a group the member is in.', 'Jemand ist einer Gruppe beigetreten, in der das Mitglied ist.'],
  ['group_recommended', 'member', 'community', 'automation', 'unverified', 'Group recommendation', 'Gruppen-Empfehlung', 'Groups that match the member\'s interests.', 'Gruppen, die zu den Interessen passen.'],
  ['group_activity_update', 'member', 'community', 'system', 'unverified', 'Group activity', 'Gruppen-Aktivität', 'Activity in one of the member\'s groups.', 'Aktivität in einer Gruppe des Mitglieds.'],
  ['group_milestone_reached', 'member', 'community', 'system', 'unverified', 'Group milestone', 'Gruppen-Meilenstein', 'A group reached a milestone.', 'Eine Gruppe hat einen Meilenstein erreicht.'],
  ['group_invitation_received', 'member', 'community', 'member_activity', 'unverified', 'Group invitation', 'Gruppen-Einladung', 'Someone invited the member to a group.', 'Jemand hat das Mitglied in eine Gruppe eingeladen.'],
  ['community_digest', 'member', 'community', 'automation', 'not_localized', 'Community digest', 'Community-Zusammenfassung', 'A digest of community activity.', 'Eine Zusammenfassung der Community-Aktivität.'],
  ['community_highlights', 'member', 'community', 'automation', 'not_localized', 'Community highlights', 'Community-Highlights', 'Highlights from the community.', 'Highlights aus der Community.'],
  ['weekly_recap_ready', 'member', 'community', 'automation', 'not_localized', 'Weekly recap', 'Wochenrückblick', 'The member\'s weekly recap is ready.', 'Der Wochenrückblick ist fertig.'],
  ['weekly_community_growth', 'member', 'community', 'system', 'unverified', 'Community growth', 'Community-Wachstum', 'How the community grew this week.', 'Wie die Community diese Woche gewachsen ist.'],

  // ── Meetups & live rooms ──────────────────────────────────────────────────
  ['meetup_recommended', 'member', 'meetups', 'automation', 'unverified', 'Meetup recommendation', 'Meetup-Empfehlung', 'A meetup that fits the member.', 'Ein Meetup, das zum Mitglied passt.'],
  ['meetup_starting_soon', 'member', 'meetups', 'system', 'unverified', 'Meetup starting soon', 'Meetup beginnt bald', 'A meetup the member joined starts soon.', 'Ein Meetup, an dem das Mitglied teilnimmt, beginnt bald.'],
  ['meetup_starting_now', 'member', 'meetups', 'system', 'unverified', 'Meetup starting now', 'Meetup beginnt jetzt', 'A meetup the member joined starts now.', 'Ein Meetup, an dem das Mitglied teilnimmt, beginnt jetzt.'],
  ['meetup_rsvp_confirmed', 'member', 'meetups', 'member_activity', 'unverified', 'RSVP confirmed', 'Zusage bestätigt', 'The member\'s RSVP was confirmed.', 'Die Zusage wurde bestätigt.'],
  ['someone_rsvpd_your_meetup', 'member', 'meetups', 'member_activity', 'unverified', 'RSVP to your meetup', 'Zusage zu deinem Meetup', 'Someone RSVPed to the member\'s meetup.', 'Jemand hat für ein eigenes Meetup zugesagt.'],
  ['meetup_cancelled', 'member', 'meetups', 'member_activity', 'unverified', 'Meetup cancelled', 'Meetup abgesagt', 'A meetup was cancelled.', 'Ein Meetup wurde abgesagt.'],
  ['new_meetup_in_group', 'member', 'meetups', 'member_activity', 'unverified', 'New meetup in a group', 'Neues Meetup in einer Gruppe', 'A group the member is in scheduled a meetup.', 'Eine Gruppe hat ein Meetup angesetzt.'],
  ['live_room_starting', 'member', 'live_rooms', 'member_activity', 'unverified', 'Live room starting', 'Live-Room startet', 'A live room is starting.', 'Ein Live-Room startet.'],
  ['someone_joined_live_room', 'member', 'live_rooms', 'member_activity', 'unverified', 'Someone joined your live room', 'Jemand ist deinem Live-Room beigetreten', 'Someone joined the member\'s live room.', 'Jemand ist dem eigenen Live-Room beigetreten.'],
  ['live_room_ended_summary', 'member', 'live_rooms', 'member_activity', 'unverified', 'Live room summary', 'Live-Room-Zusammenfassung', 'Summary after a live room ended.', 'Zusammenfassung nach einem Live-Room.'],
  ['live_room_highlight_added', 'member', 'live_rooms', 'member_activity', 'unverified', 'Live room highlight', 'Live-Room-Highlight', 'A highlight was added to a live room.', 'Ein Highlight wurde zu einem Live-Room hinzugefügt.'],
  ['live_room_invite', 'member', 'live_rooms', 'automation', 'unverified', 'Live room invitation', 'Live-Room-Einladung', 'An invitation to a live room.', 'Eine Einladung zu einem Live-Room.'],
  ['live_room_recording_ready', 'member', 'live_rooms', 'system', 'unverified', 'Recording ready', 'Aufzeichnung bereit', 'A live room recording is ready.', 'Eine Live-Room-Aufzeichnung ist bereit.'],

  // ── My Journey & diary ────────────────────────────────────────────────────
  ['daily_goal_celebration', 'member', 'journey', 'member_activity', 'unverified', 'Daily goal reached', 'Tagesziel erreicht', 'Celebration when the member reaches the daily goal.', 'Feier, wenn das Tagesziel erreicht ist.'],
  ['phase_milestone_celebration', 'member', 'journey', 'member_activity', 'unverified', 'Journey phase reached', 'Journey-Phase erreicht', 'Celebration of a new phase in My Journey.', 'Feier einer neuen Phase in My Journey.'],
  ['progress_milestone_celebration', 'member', 'journey', 'member_activity', 'unverified', 'Progress milestone', 'Fortschritts-Meilenstein', 'Celebration of a progress milestone.', 'Feier eines Fortschritts-Meilensteins.'],
  ['diary_streak_milestone', 'member', 'journey', 'member_activity', 'unverified', 'Diary streak', 'Tagebuch-Serie', 'The member kept a diary streak.', 'Eine Tagebuch-Serie wurde erreicht.'],
  ['memory_garden_grew', 'member', 'journey', 'member_activity', 'ready', 'Memory Garden grew (in-app)', 'Memory Garden gewachsen (in der App)', 'In-app only: something new was stored in the Memory Garden.', 'Nur in der App: etwas Neues wurde im Memory Garden gespeichert.'],
  ['onboarding_step_completed', 'member', 'journey', 'member_activity', 'unverified', 'Onboarding step done', 'Onboarding-Schritt erledigt', 'An onboarding step was completed.', 'Ein Onboarding-Schritt wurde erledigt.'],

  // ── Recommendations & opportunities ───────────────────────────────────────
  ['new_recommendation', 'member', 'recommendations', 'system', 'unverified', 'New recommendation', 'Neue Empfehlung', 'A new recommendation for the member.', 'Eine neue Empfehlung für das Mitglied.'],
  ['high_impact_recommendation', 'member', 'recommendations', 'system', 'unverified', 'Important recommendation', 'Wichtige Empfehlung', 'A recommendation with high impact.', 'Eine Empfehlung mit großer Wirkung.'],
  ['recommendation_activated', 'member', 'recommendations', 'member_activity', 'unverified', 'Recommendation activated', 'Empfehlung aktiviert', 'The member activated a recommendation.', 'Das Mitglied hat eine Empfehlung aktiviert.'],
  ['opportunity_surfaced', 'member', 'recommendations', 'system', 'unverified', 'New opportunity', 'Neue Gelegenheit', 'An opportunity that fits the member right now.', 'Eine Gelegenheit, die gerade passt.'],
  ['opportunity_expiring', 'member', 'recommendations', 'system', 'unverified', 'Opportunity expiring', 'Gelegenheit läuft ab', 'An opportunity is about to expire.', 'Eine Gelegenheit läuft bald ab.'],
  ['health_priority_opportunity', 'member', 'recommendations', 'system', 'unverified', 'Health opportunity', 'Gesundheits-Gelegenheit', 'A health-priority opportunity.', 'Eine Gelegenheit mit Gesundheitspriorität.'],
  ['service_recommendation', 'member', 'recommendations', 'system', 'unverified', 'Service recommendation', 'Service-Empfehlung', 'A service that fits the member.', 'Ein passender Service.'],
  ['product_recommendation', 'member', 'recommendations', 'system', 'unverified', 'Product recommendation', 'Produkt-Empfehlung', 'A product that fits the member.', 'Ein passendes Produkt.'],
  ['usage_outcome_checkin', 'member', 'recommendations', 'system', 'unverified', 'How did it go?', 'Wie war es?', 'A check-in after using a service or product.', 'Nachfrage nach Nutzung eines Services oder Produkts.'],
  ['intent_match_found_for_dictator', 'member', 'recommendations', 'system', 'unverified', 'Match for your request', 'Treffer für deine Anfrage', 'Someone matches what the member asked for.', 'Jemand passt zu dem, was das Mitglied gesucht hat.'],
  ['intent_lead_for_counterparty', 'member', 'recommendations', 'system', 'unverified', 'Someone is looking for you', 'Jemand sucht dich', 'A member is looking for what this member offers.', 'Ein Mitglied sucht, was dieses Mitglied anbietet.'],
  ['intent_mutual_interest', 'member', 'recommendations', 'system', 'unverified', 'Mutual interest', 'Gegenseitiges Interesse', 'Both sides are interested.', 'Beide Seiten sind interessiert.'],
  ['intent_partner_reciprocal_revealed', 'member', 'recommendations', 'system', 'unverified', 'Mutual match revealed', 'Gegenseitiges Match enthüllt', 'A mutual partner match was revealed.', 'Ein gegenseitiges Partner-Match wurde enthüllt.'],
  ['intent_compass_change_resurface', 'member', 'recommendations', 'system', 'unverified', 'Request resurfaced', 'Anfrage wieder aktuell', 'An earlier request is relevant again.', 'Eine frühere Anfrage ist wieder aktuell.'],
  ['intent_throttled', 'member', 'recommendations', 'system', 'unverified', 'Request paused', 'Anfrage pausiert', 'Too many requests; one was paused.', 'Zu viele Anfragen; eine wurde pausiert.'],
  ['intent_proactive_prompt_summary', 'member', 'recommendations', 'system', 'unverified', 'Request summary', 'Anfragen-Zusammenfassung', 'A summary of the member\'s requests.', 'Eine Zusammenfassung der Anfragen.'],

  // ── Health ────────────────────────────────────────────────────────────────
  ['daily_vitana_index_ready', 'member', 'health', 'system', 'unverified', 'Vitana Index ready', 'Vitana Index bereit', 'Today\'s Vitana Index is ready.', 'Der heutige Vitana Index ist bereit.'],
  ['health_score_improvement', 'member', 'health', 'system', 'unverified', 'Health score improved', 'Gesundheitswert verbessert', 'A health score went up.', 'Ein Gesundheitswert ist gestiegen.'],
  ['health_score_decline', 'member', 'health', 'system', 'unverified', 'Health score declined', 'Gesundheitswert gesunken', 'A health score went down.', 'Ein Gesundheitswert ist gesunken.'],
  ['longevity_signal_alert', 'member', 'health', 'system', 'unverified', 'Longevity signal', 'Langlebigkeits-Signal', 'An important longevity signal.', 'Ein wichtiges Langlebigkeits-Signal.'],
  ['lab_report_processed', 'member', 'health', 'member_activity', 'unverified', 'Lab report processed', 'Laborbericht verarbeitet', 'An uploaded lab report was processed.', 'Ein hochgeladener Laborbericht wurde verarbeitet.'],
  ['health_test_result_ready', 'member', 'health', 'system', 'unverified', 'Test result ready', 'Testergebnis bereit', 'A partner lab test result is ready.', 'Ein Testergebnis eines Partnerlabors ist bereit.'],
  ['partner_test_status_changed', 'member', 'health', 'system', 'unverified', 'Test status update', 'Test-Status', 'The status of a partner lab test changed.', 'Der Status eines Partnerlabor-Tests hat sich geändert.'],
  ['wearable_data_synced', 'member', 'health', 'system', 'unverified', 'Wearable synced (silent)', 'Wearable synchronisiert (still)', 'Silent: wearable data synced.', 'Still: Wearable-Daten synchronisiert.'],
  ['predictive_signal_detected', 'member', 'health', 'system', 'unverified', 'Health signal', 'Gesundheitssignal', 'A predictive health signal was detected.', 'Ein vorausschauendes Gesundheitssignal wurde erkannt.'],
  ['positive_momentum_detected', 'member', 'health', 'system', 'unverified', 'Positive momentum', 'Positiver Trend', 'Things are going well.', 'Es läuft gut.'],
  ['social_withdrawal_signal', 'member', 'health', 'system', 'unverified', 'Social withdrawal signal', 'Signal für sozialen Rückzug', 'Signs the member is withdrawing socially.', 'Anzeichen für sozialen Rückzug.'],
  ['risk_mitigation_suggestion', 'member', 'health', 'system', 'unverified', 'Risk suggestion', 'Risiko-Vorschlag', 'A suggestion to lower a health risk.', 'Ein Vorschlag, ein Gesundheitsrisiko zu senken.'],

  // ── Account & system ──────────────────────────────────────────────────────
  ['welcome_to_vitana', 'member', 'account', 'member_activity', 'unverified', 'Welcome to Vitana', 'Willkommen bei Vitana', 'Sent once after sign-up.', 'Einmal nach der Registrierung.'],
  ['complete_your_profile', 'member', 'account', 'member_activity', 'unverified', 'Complete your profile', 'Profil vervollständigen', 'A nudge to finish the profile.', 'Ein Hinweis, das Profil zu vervollständigen.'],
  ['feedback_ticket_resolved', 'member', 'account', 'system', 'unverified', 'Your report was resolved', 'Deine Meldung wurde gelöst', 'A support ticket or bug report the member filed was resolved.', 'Eine Support-Anfrage oder Fehlermeldung wurde gelöst.'],
  ['marketplace_listing_approved', 'member', 'account', 'system', 'unverified', 'Listing approved', 'Angebot freigegeben', 'The member\'s marketplace listing was approved.', 'Das Marktplatz-Angebot wurde freigegeben.'],
  ['marketplace_listing_rejected', 'member', 'account', 'system', 'unverified', 'Listing rejected', 'Angebot abgelehnt', 'The member\'s marketplace listing was rejected.', 'Das Marktplatz-Angebot wurde abgelehnt.'],
  ['marketplace_listing_removed', 'member', 'account', 'system', 'unverified', 'Listing removed', 'Angebot entfernt', 'The member\'s marketplace listing was removed.', 'Das Marktplatz-Angebot wurde entfernt.'],
  ['trial_welcome', 'member', 'account', 'system', 'unverified', 'Trial started', 'Testphase gestartet', 'The member\'s trial started.', 'Die Testphase hat begonnen.'],
  ['trial_midpoint', 'member', 'account', 'system', 'unverified', 'Trial halfway', 'Testphase zur Hälfte', 'Halfway through the trial.', 'Die Testphase ist zur Hälfte vorbei.'],
  ['trial_ending_2d', 'member', 'account', 'system', 'unverified', 'Trial ends in 2 days', 'Testphase endet in 2 Tagen', 'The trial ends in two days.', 'Die Testphase endet in zwei Tagen.'],
  ['trial_ending_1d', 'member', 'account', 'system', 'unverified', 'Trial ends tomorrow', 'Testphase endet morgen', 'The trial ends tomorrow.', 'Die Testphase endet morgen.'],
  ['trial_cancelled_winback', 'member', 'account', 'system', 'unverified', 'Come back offer', 'Rückkehr-Angebot', 'After a cancelled trial.', 'Nach einer beendeten Testphase.'],
  ['trial_winback_one_shot', 'member', 'account', 'system', 'unverified', 'Last come-back offer', 'Letztes Rückkehr-Angebot', 'One last offer after a trial.', 'Ein letztes Angebot nach der Testphase.'],
  ['founding_midpoint', 'member', 'account', 'system', 'unverified', 'Founding membership halfway', 'Gründungsmitgliedschaft zur Hälfte', 'Halfway through the founding membership.', 'Die Gründungsmitgliedschaft ist zur Hälfte vorbei.'],
  ['founding_ending_2d', 'member', 'account', 'system', 'unverified', 'Founding membership ends in 2 days', 'Gründungsmitgliedschaft endet in 2 Tagen', 'The founding membership ends in two days.', 'Die Gründungsmitgliedschaft endet in zwei Tagen.'],
  ['founding_ending_1d', 'member', 'account', 'system', 'unverified', 'Founding membership ends tomorrow', 'Gründungsmitgliedschaft endet morgen', 'The founding membership ends tomorrow.', 'Die Gründungsmitgliedschaft endet morgen.'],

  // ── Wallet, creators & growth ─────────────────────────────────────────────
  ['wallet_credits_earned', 'member', 'wallet', 'system', 'unverified', 'Credits earned', 'Credits verdient', 'The member earned credits.', 'Das Mitglied hat Credits verdient.'],
  ['wallet_payout_received', 'member', 'wallet', 'system', 'unverified', 'Payout received', 'Auszahlung erhalten', 'A payout arrived.', 'Eine Auszahlung ist eingegangen.'],
  ['wallet_payout_failed', 'member', 'wallet', 'system', 'unverified', 'Payout failed', 'Auszahlung fehlgeschlagen', 'A payout failed.', 'Eine Auszahlung ist fehlgeschlagen.'],
  ['creator_earnings_report', 'member', 'wallet', 'system', 'unverified', 'Creator earnings', 'Creator-Einnahmen', 'A creator\'s earnings report.', 'Ein Einnahmenbericht für Creator.'],
  ['creator_setup_reminder', 'member', 'wallet', 'system', 'unverified', 'Finish creator setup', 'Creator-Einrichtung abschließen', 'A reminder to finish the creator setup.', 'Eine Erinnerung, die Creator-Einrichtung abzuschließen.'],
  ['invite_friends_prompt', 'member', 'wallet', 'system', 'unverified', 'Invite friends', 'Freunde einladen', 'A prompt to invite friends.', 'Eine Aufforderung, Freunde einzuladen.'],
  ['friend_joined_vitana', 'member', 'wallet', 'member_activity', 'unverified', 'A friend joined', 'Ein Freund ist dabei', 'Someone the member invited joined Vitana.', 'Jemand, den das Mitglied eingeladen hat, ist beigetreten.'],
  ['friend_joined_your_group', 'member', 'wallet', 'member_activity', 'unverified', 'A friend joined your group', 'Ein Freund ist deiner Gruppe beigetreten', 'A friend joined the member\'s group.', 'Ein Freund ist der Gruppe beigetreten.'],
  ['referral_signup', 'member', 'wallet', 'member_activity', 'unverified', 'Referral signed up', 'Empfehlung registriert', 'Someone signed up through the member\'s link.', 'Jemand hat sich über den Link registriert.'],
  ['referral_reward_earned', 'member', 'wallet', 'system', 'unverified', 'Referral reward', 'Empfehlungs-Belohnung', 'The member earned a referral reward.', 'Das Mitglied hat eine Empfehlungs-Belohnung erhalten.'],
  ['share_countdown_prompt', 'member', 'wallet', 'system', 'unverified', 'Share prompt', 'Teilen-Hinweis', 'A prompt to share something.', 'Ein Hinweis, etwas zu teilen.'],

  // ── Admin ─────────────────────────────────────────────────────────────────
  ['admin_insight_urgent', 'admin', 'admin', 'system', 'ready', 'Urgent admin insight', 'Dringender Admin-Hinweis', 'Something in the community needs an admin now.', 'Etwas in der Community braucht jetzt einen Admin.'],
  ['admin_insight_action_needed', 'admin', 'admin', 'system', 'unverified', 'Admin action needed', 'Admin-Aktion nötig', 'An insight that needs an admin decision.', 'Ein Hinweis, der eine Admin-Entscheidung braucht.'],
  ['admin_digest', 'admin', 'admin', 'automation', 'not_localized', 'Admin digest', 'Admin-Zusammenfassung', 'A digest for admins from an automation.', 'Eine Zusammenfassung für Admins aus einer Automation.'],
];

export const NOTIFICATION_CATALOG: ReadonlyMap<string, NotificationCatalogEntry> = new Map(
  ROWS.map(([type, audience, group, trigger, text, labelEn, labelDe, descEn, descDe]) => [
    type,
    { type, audience, group, trigger, text, label: { en: labelEn, de: labelDe }, description: { en: descEn, de: descDe } },
  ]),
);

/**
 * Automations whose notification text is translated. Every other automation
 * writes English only today (its handler file calls no tt()), so its switch
 * refuses to turn on until the text is translated.
 */
export const LOCALIZED_AUTOMATION_DOMAINS: ReadonlySet<string> = new Set(['memory-intelligence']);

export function catalogEntryFor(type: string): NotificationCatalogEntry {
  return NOTIFICATION_CATALOG.get(type) ?? {
    type,
    audience: 'member',
    group: 'other',
    trigger: 'system',
    text: 'unverified',
    label: { en: type, de: type },
    description: {
      en: 'Not in the catalog yet — added automatically when something first tried to send it.',
      de: 'Noch nicht im Katalog — automatisch hinzugefügt, als etwas es zum ersten Mal senden wollte.',
    },
  };
}
