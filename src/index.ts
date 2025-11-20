/**
 * Cloudflare Worker to monitor Cloudflare Status page and post incidents to Google Chat
 */

// Constants
const KV_TTL_DAYS = 30;
const KV_TTL_SECONDS = KV_TTL_DAYS * 24 * 60 * 60;
const RECENT_INCIDENT_DAYS = 7;
const RECENT_INCIDENT_MS = RECENT_INCIDENT_DAYS * 24 * 60 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 60000; // 1 minute
const MAX_RETRIES = 3;
const DIGEST_THRESHOLD = 3; // Send digest if more than 3 new incidents

// Status priority levels
const STATUS_PRIORITIES: Record<string, number> = {
  investigating: 1,
  identified: 2,
  monitoring: 3,
  resolved: 4,
};

// Impact priority levels
const IMPACT_LEVELS: Record<string, number> = {
  none: 0,
  minor: 1,
  major: 2,
  critical: 3,
};

// Color mapping for incident impact
const IMPACT_COLORS: Record<string, string> = {
  critical: '#D32F2F',  // Red
  major: '#F57C00',     // Orange
  minor: '#FBC02D',     // Yellow
  none: '#757575'       // Grey
};

// Emoji mapping for incident impact
const IMPACT_EMOJIS: Record<string, string> = {
  critical: '🔴',
  major: '🟠',
  minor: '🟡',
  none: '⚪'
};

// Environment bindings
interface Env {
  INCIDENTS_KV: KVNamespace;
  GOOGLE_CHAT_WEBHOOK: string;
  STATUS_API_URL: string;
  MIN_IMPACT_LEVEL?: string; // Optional: filter by severity (none, minor, major, critical)
}

// API Response types
interface CloudflareStatusResponse {
  page: {
    id: string;
    name: string;
    url: string;
    updated_at: string;
  };
  incidents: Incident[];
}

interface Incident {
  id: string;
  name: string;
  status: string;
  impact: 'none' | 'minor' | 'major' | 'critical';
  created_at: string;
  updated_at: string;
  started_at: string;
  resolved_at: string | null;
  shortlink: string;
  incident_updates: IncidentUpdate[];
  components?: Component[];
}

interface Component {
  id: string;
  name: string;
  status: string;
}

interface IncidentUpdate {
  body: string;
  status: string;
  created_at: string;
  display_at: string;
}

// KV stored incident data
interface StoredIncident {
  status: string;
  timestamp: string;
}

// Process result type
interface ProcessResult {
  id: string;
  name: string;
  impact: string;
  status: string;
  storedStatus: string | null;
  action: 'none' | 'new_incident_notification' | 'resolution_notification' | 'status_updated' | 'monitoring_notification' | 'digest_notification' | 'filtered';
}

// Metrics type
interface Metrics {
  lastRun: string;
  notificationsSent: number;
  incidentsProcessed: number;
  errors: number;
}

/**
 * Fetch incidents from Cloudflare Status API
 */
async function fetchIncidents(statusApiUrl: string): Promise<Incident[]> {
  try {
    const response = await fetch(statusApiUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch incidents: ${response.status} ${response.statusText}`);
    }

    const data: CloudflareStatusResponse = await response.json();
    return data.incidents || [];
  } catch (error) {
    console.error('Error fetching incidents:', error);
    throw error;
  }
}

/**
 * Get stored incident data from KV (with batch support)
 */
async function getStoredIncident(incidentId: string, kv: KVNamespace): Promise<StoredIncident | null> {
  const data = await kv.get(`incident:${incidentId}`);
  if (!data) return null;

  try {
    return JSON.parse(data) as StoredIncident;
  } catch {
    // Handle legacy format (just timestamp string)
    return {
      status: 'identified',
      timestamp: data,
    };
  }
}

/**
 * Batch fetch stored incidents
 */
async function batchGetStoredIncidents(incidentIds: string[], kv: KVNamespace): Promise<Map<string, StoredIncident | null>> {
  const results = await Promise.all(
    incidentIds.map(id => getStoredIncident(id, kv))
  );

  const map = new Map<string, StoredIncident | null>();
  incidentIds.forEach((id, index) => {
    map.set(id, results[index]);
  });

  return map;
}

/**
 * Store incident data in KV
 */
async function storeIncident(incidentId: string, status: string, kv: KVNamespace): Promise<void> {
  const incidentData: StoredIncident = {
    status,
    timestamp: new Date().toISOString(),
  };

  await kv.put(`incident:${incidentId}`, JSON.stringify(incidentData), {
    expirationTtl: KV_TTL_SECONDS,
  });
}

/**
 * Retry wrapper with exponential backoff
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries: number = MAX_RETRIES): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      const delay = Math.pow(2, i) * 1000;
      console.log(`Retry ${i + 1}/${maxRetries} after ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Max retries exceeded');
}

/**
 * Format duration
 */
function formatDuration(durationMs: number): string {
  const hours = Math.floor(durationMs / (1000 * 60 * 60));
  const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * Format components list
 */
function formatComponents(components?: Component[]): string {
  if (!components || components.length === 0) return '';
  return components.map(c => c.name).join(', ');
}

/**
 * Send notification with retry
 */
async function sendNotification(webhookUrl: string, message: any): Promise<void> {
  await withRetry(async () => {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to send notification: ${response.status} ${response.statusText} - ${errorText}`);
    }
  });
}

/**
 * Format and send incident notification to Google Chat
 */
async function sendGoogleChatNotification(incident: Incident, webhookUrl: string): Promise<void> {
  const emoji = IMPACT_EMOJIS[incident.impact] || IMPACT_EMOJIS.none;

  const latestUpdate = incident.incident_updates[0];
  const updateBody = latestUpdate?.body || 'No details available';

  const createdDate = new Date(incident.created_at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short'
  });

  const affectedComponents = formatComponents(incident.components);

  const message = {
    cards: [
      {
        header: {
          title: `${emoji} Cloudflare Incident: ${incident.name}`,
          subtitle: `Impact: ${incident.impact.toUpperCase()} | Status: ${incident.status}`,
        },
        sections: [
          {
            widgets: [
              {
                keyValue: {
                  topLabel: 'Impact Level',
                  content: incident.impact.toUpperCase(),
                  contentMultiline: false,
                  icon: 'DESCRIPTION',
                },
              },
              {
                keyValue: {
                  topLabel: 'Status',
                  content: incident.status,
                  contentMultiline: false,
                  icon: 'CLOCK',
                },
              },
              {
                keyValue: {
                  topLabel: 'Started',
                  content: createdDate,
                  contentMultiline: false,
                  icon: 'EVENT_SEAT',
                },
              },
              ...(affectedComponents ? [{
                keyValue: {
                  topLabel: 'Affected Components',
                  content: affectedComponents,
                  contentMultiline: true,
                  icon: 'BOOKMARK',
                },
              }] : []),
            ],
          },
          {
            widgets: [
              {
                textParagraph: {
                  text: `<b>Latest Update:</b><br>${updateBody}`,
                },
              },
            ],
          },
          {
            widgets: [
              {
                buttons: [
                  {
                    textButton: {
                      text: 'VIEW INCIDENT',
                      onClick: {
                        openLink: {
                          url: incident.shortlink,
                        },
                      },
                    },
                  },
                  {
                    textButton: {
                      text: 'STATUS PAGE',
                      onClick: {
                        openLink: {
                          url: 'https://www.cloudflarestatus.com',
                        },
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  await sendNotification(webhookUrl, message);
  console.log(`Notification sent for incident: ${incident.id} - ${incident.name}`);
}

/**
 * Send resolution notification
 */
async function sendGoogleChatResolutionNotification(incident: Incident, webhookUrl: string): Promise<void> {
  const emoji = '✅';

  const resolutionUpdate = incident.incident_updates.find(u => u.status === 'resolved');
  const resolutionBody = resolutionUpdate?.body || 'This incident has been resolved.';

  const startTime = new Date(incident.started_at);
  const endTime = incident.resolved_at ? new Date(incident.resolved_at) : new Date();
  const duration = formatDuration(endTime.getTime() - startTime.getTime());

  const resolvedDate = new Date(incident.resolved_at || incident.updated_at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short'
  });

  const affectedComponents = formatComponents(incident.components);

  const message = {
    cards: [
      {
        header: {
          title: `${emoji} Incident Resolved: ${incident.name}`,
          subtitle: `Duration: ${duration} | Resolved at ${resolvedDate}`,
        },
        sections: [
          {
            widgets: [
              {
                keyValue: {
                  topLabel: 'Status',
                  content: 'RESOLVED',
                  contentMultiline: false,
                  icon: 'STAR',
                },
              },
              {
                keyValue: {
                  topLabel: 'Impact Level',
                  content: incident.impact.toUpperCase(),
                  contentMultiline: false,
                  icon: 'DESCRIPTION',
                },
              },
              {
                keyValue: {
                  topLabel: 'Duration',
                  content: duration,
                  contentMultiline: false,
                  icon: 'CLOCK',
                },
              },
              ...(affectedComponents ? [{
                keyValue: {
                  topLabel: 'Affected Components',
                  content: affectedComponents,
                  contentMultiline: true,
                  icon: 'BOOKMARK',
                },
              }] : []),
            ],
          },
          {
            widgets: [
              {
                textParagraph: {
                  text: `<b>Resolution:</b><br>${resolutionBody}`,
                },
              },
            ],
          },
          {
            widgets: [
              {
                buttons: [
                  {
                    textButton: {
                      text: 'VIEW INCIDENT',
                      onClick: {
                        openLink: {
                          url: incident.shortlink,
                        },
                      },
                    },
                  },
                  {
                    textButton: {
                      text: 'STATUS PAGE',
                      onClick: {
                        openLink: {
                          url: 'https://www.cloudflarestatus.com',
                        },
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  await sendNotification(webhookUrl, message);
  console.log(`Resolution notification sent for incident: ${incident.id} - ${incident.name}`);
}

/**
 * Send status update notification (for intermediate status changes)
 */
async function sendStatusUpdateNotification(incident: Incident, oldStatus: string, webhookUrl: string): Promise<void> {
  const emoji = IMPACT_EMOJIS[incident.impact] || IMPACT_EMOJIS.none;

  const latestUpdate = incident.incident_updates[0];
  const updateBody = latestUpdate?.body || 'Status updated';

  const message = {
    cards: [
      {
        header: {
          title: `${emoji} Incident Update: ${incident.name}`,
          subtitle: `Status: ${oldStatus.toUpperCase()} → ${incident.status.toUpperCase()}`,
        },
        sections: [
          {
            widgets: [
              {
                keyValue: {
                  topLabel: 'New Status',
                  content: incident.status.toUpperCase(),
                  contentMultiline: false,
                  icon: 'CLOCK',
                },
              },
              {
                keyValue: {
                  topLabel: 'Impact Level',
                  content: incident.impact.toUpperCase(),
                  contentMultiline: false,
                  icon: 'DESCRIPTION',
                },
              },
            ],
          },
          {
            widgets: [
              {
                textParagraph: {
                  text: `<b>Update:</b><br>${updateBody}`,
                },
              },
            ],
          },
          {
            widgets: [
              {
                buttons: [
                  {
                    textButton: {
                      text: 'VIEW INCIDENT',
                      onClick: {
                        openLink: {
                          url: incident.shortlink,
                        },
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  await sendNotification(webhookUrl, message);
  console.log(`Status update notification sent for incident: ${incident.id} - ${oldStatus} → ${incident.status}`);
}

/**
 * Send monitoring notification (fix deployed)
 */
async function sendMonitoringNotification(incident: Incident, webhookUrl: string): Promise<void> {
  const emoji = '🔧';

  const monitoringUpdate = incident.incident_updates.find(u => u.status === 'monitoring');
  const updateBody = monitoringUpdate?.body || 'A fix has been implemented and we are monitoring the results.';

  const message = {
    cards: [
      {
        header: {
          title: `${emoji} Fix Deployed: ${incident.name}`,
          subtitle: 'Monitoring for resolution',
        },
        sections: [
          {
            widgets: [
              {
                keyValue: {
                  topLabel: 'Status',
                  content: 'MONITORING',
                  contentMultiline: false,
                  icon: 'CLOCK',
                },
              },
            ],
          },
          {
            widgets: [
              {
                textParagraph: {
                  text: `<b>Update:</b><br>${updateBody}`,
                },
              },
            ],
          },
          {
            widgets: [
              {
                buttons: [
                  {
                    textButton: {
                      text: 'VIEW INCIDENT',
                      onClick: {
                        openLink: {
                          url: incident.shortlink,
                        },
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  await sendNotification(webhookUrl, message);
  console.log(`Monitoring notification sent for incident: ${incident.id}`);
}

/**
 * Send digest notification (multiple incidents)
 */
async function sendDigestNotification(incidents: Incident[], webhookUrl: string): Promise<void> {
  const emoji = '📊';

  const criticalCount = incidents.filter(i => i.impact === 'critical').length;
  const majorCount = incidents.filter(i => i.impact === 'major').length;
  const minorCount = incidents.filter(i => i.impact === 'minor').length;

  const incidentList = incidents.slice(0, 10).map(inc =>
    `• ${IMPACT_EMOJIS[inc.impact]} <b>${inc.name}</b> (${inc.impact})`
  ).join('<br>');

  const moreText = incidents.length > 10 ? `<br>...and ${incidents.length - 10} more` : '';

  const message = {
    cards: [
      {
        header: {
          title: `${emoji} Multiple Incidents Detected`,
          subtitle: `${incidents.length} new incidents`,
        },
        sections: [
          {
            widgets: [
              {
                keyValue: {
                  topLabel: 'Critical',
                  content: criticalCount.toString(),
                  contentMultiline: false,
                  icon: 'DESCRIPTION',
                },
              },
              {
                keyValue: {
                  topLabel: 'Major',
                  content: majorCount.toString(),
                  contentMultiline: false,
                  icon: 'DESCRIPTION',
                },
              },
              {
                keyValue: {
                  topLabel: 'Minor',
                  content: minorCount.toString(),
                  contentMultiline: false,
                  icon: 'DESCRIPTION',
                },
              },
            ],
          },
          {
            widgets: [
              {
                textParagraph: {
                  text: `<b>Incidents:</b><br>${incidentList}${moreText}`,
                },
              },
            ],
          },
          {
            widgets: [
              {
                buttons: [
                  {
                    textButton: {
                      text: 'VIEW ALL',
                      onClick: {
                        openLink: {
                          url: 'https://www.cloudflarestatus.com',
                        },
                      },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  await sendNotification(webhookUrl, message);
  console.log(`Digest notification sent for ${incidents.length} incidents`);
}

/**
 * Check if incident should be filtered by impact level
 */
function shouldFilterByImpact(incident: Incident, minImpactLevel?: string): boolean {
  if (!minImpactLevel) return false;

  const minLevel = IMPACT_LEVELS[minImpactLevel] || 0;
  const incidentLevel = IMPACT_LEVELS[incident.impact] || 0;

  return incidentLevel < minLevel;
}

/**
 * Check rate limiting
 */
async function isRateLimited(kv: KVNamespace): Promise<boolean> {
  const lastNotification = await kv.get('metrics:last_notification');
  if (!lastNotification) return false;

  const timeSinceLastNotification = Date.now() - parseInt(lastNotification);
  return timeSinceLastNotification < RATE_LIMIT_COOLDOWN_MS;
}

/**
 * Update metrics
 */
async function updateMetrics(kv: KVNamespace, updates: Partial<Metrics>): Promise<void> {
  const current = await getMetrics(kv);
  const newMetrics: Metrics = {
    ...current,
    ...updates,
  };

  await kv.put('metrics:data', JSON.stringify(newMetrics));

  if (updates.notificationsSent) {
    await kv.put('metrics:last_notification', Date.now().toString());
  }
}

/**
 * Get metrics
 */
async function getMetrics(kv: KVNamespace): Promise<Metrics> {
  const data = await kv.get('metrics:data');
  if (!data) {
    return {
      lastRun: new Date().toISOString(),
      notificationsSent: 0,
      incidentsProcessed: 0,
      errors: 0,
    };
  }

  try {
    return JSON.parse(data) as Metrics;
  } catch {
    return {
      lastRun: new Date().toISOString(),
      notificationsSent: 0,
      incidentsProcessed: 0,
      errors: 0,
    };
  }
}

/**
 * Process incidents (shared logic for scheduled and fetch handlers)
 */
async function processIncidents(env: Env, returnResults: boolean = false): Promise<ProcessResult[] | void> {
  console.log('Starting incident processing...');

  // Check rate limiting
  if (await isRateLimited(env.INCIDENTS_KV)) {
    console.log('Rate limited - skipping this run');
    return returnResults ? [] : undefined;
  }

  const incidents = await fetchIncidents(env.STATUS_API_URL);
  console.log(`Found ${incidents.length} total incidents`);

  // Filter to recent incidents only
  const recentIncidents = incidents.filter(inc => {
    const age = Date.now() - new Date(inc.started_at).getTime();
    return age < RECENT_INCIDENT_MS;
  });
  console.log(`Filtered to ${recentIncidents.length} recent incidents (last ${RECENT_INCIDENT_DAYS} days)`);

  // Batch fetch stored incidents
  const storedIncidentsMap = await batchGetStoredIncidents(
    recentIncidents.map(i => i.id),
    env.INCIDENTS_KV
  );

  const results: ProcessResult[] = [];
  const newIncidents: Incident[] = [];
  const resolvedIncidents: Incident[] = [];
  const monitoringIncidents: Incident[] = [];
  const statusUpdates: Array<{ incident: Incident; oldStatus: string }> = [];

  // Process each incident
  for (const incident of recentIncidents) {
    const storedIncident = storedIncidentsMap.get(incident.id);

    const result: ProcessResult = {
      id: incident.id,
      name: incident.name,
      impact: incident.impact,
      status: incident.status,
      storedStatus: storedIncident?.status || null,
      action: 'none',
    };

    // Filter by impact level
    if (shouldFilterByImpact(incident, env.MIN_IMPACT_LEVEL)) {
      result.action = 'filtered';
      console.log(`Incident filtered by impact level: ${incident.id} (${incident.impact})`);
      results.push(result);
      continue;
    }

    if (!storedIncident) {
      // New incident - send notification only if not already resolved
      if (incident.status !== 'resolved') {
        console.log(`New incident detected: ${incident.id} - ${incident.name}`);
        newIncidents.push(incident);
        result.action = 'new_incident_notification';
      }
      await storeIncident(incident.id, incident.status, env.INCIDENTS_KV);
    } else {
      // Existing incident - check for status changes
      if (storedIncident.status !== 'resolved' && incident.status === 'resolved') {
        console.log(`Incident resolved: ${incident.id} - ${incident.name}`);
        resolvedIncidents.push(incident);
        result.action = 'resolution_notification';
        await storeIncident(incident.id, incident.status, env.INCIDENTS_KV);
      } else if (storedIncident.status !== 'monitoring' && incident.status === 'monitoring') {
        console.log(`Incident monitoring: ${incident.id} - ${incident.name}`);
        monitoringIncidents.push(incident);
        result.action = 'monitoring_notification';
        await storeIncident(incident.id, incident.status, env.INCIDENTS_KV);
      } else if (storedIncident.status !== incident.status) {
        const oldPriority = STATUS_PRIORITIES[storedIncident.status] || 0;
        const newPriority = STATUS_PRIORITIES[incident.status] || 0;

        if (newPriority > oldPriority) {
          console.log(`Incident status progressed: ${incident.id} - ${storedIncident.status} → ${incident.status}`);
          statusUpdates.push({ incident, oldStatus: storedIncident.status });
          result.action = 'status_updated';
        }
        await storeIncident(incident.id, incident.status, env.INCIDENTS_KV);
      } else {
        console.log(`Incident unchanged: ${incident.id} - ${incident.name} (${incident.status})`);
      }
    }

    results.push(result);
  }

  // Send notifications in parallel with graceful error handling
  const notifications: Promise<void>[] = [];

  // Handle digest or individual notifications for new incidents
  if (newIncidents.length > 0) {
    if (newIncidents.length >= DIGEST_THRESHOLD) {
      console.log(`Sending digest notification for ${newIncidents.length} new incidents`);
      notifications.push(
        sendDigestNotification(newIncidents, env.GOOGLE_CHAT_WEBHOOK).catch(err => {
          console.error('Failed to send digest notification:', err);
        })
      );
    } else {
      newIncidents.forEach(incident => {
        notifications.push(
          sendGoogleChatNotification(incident, env.GOOGLE_CHAT_WEBHOOK).catch(err => {
            console.error(`Failed to send notification for ${incident.id}:`, err);
          })
        );
      });
    }
  }

  // Send resolution notifications
  resolvedIncidents.forEach(incident => {
    notifications.push(
      sendGoogleChatResolutionNotification(incident, env.GOOGLE_CHAT_WEBHOOK).catch(err => {
        console.error(`Failed to send resolution notification for ${incident.id}:`, err);
      })
    );
  });

  // Send monitoring notifications
  monitoringIncidents.forEach(incident => {
    notifications.push(
      sendMonitoringNotification(incident, env.GOOGLE_CHAT_WEBHOOK).catch(err => {
        console.error(`Failed to send monitoring notification for ${incident.id}:`, err);
      })
    );
  });

  // Send status update notifications
  statusUpdates.forEach(({ incident, oldStatus }) => {
    notifications.push(
      sendStatusUpdateNotification(incident, oldStatus, env.GOOGLE_CHAT_WEBHOOK).catch(err => {
        console.error(`Failed to send status update notification for ${incident.id}:`, err);
      })
    );
  });

  // Wait for all notifications to complete (with graceful failure handling)
  const notificationResults = await Promise.allSettled(notifications);
  const failedNotifications = notificationResults.filter(r => r.status === 'rejected').length;
  const successfulNotifications = notificationResults.filter(r => r.status === 'fulfilled').length;

  console.log(`Sent ${successfulNotifications} notifications, ${failedNotifications} failed`);

  // Update metrics
  await updateMetrics(env.INCIDENTS_KV, {
    lastRun: new Date().toISOString(),
    notificationsSent: successfulNotifications,
    incidentsProcessed: recentIncidents.length,
    errors: failedNotifications,
  });

  console.log('Incident processing completed');

  return returnResults ? results : undefined;
}

/**
 * Main scheduled event handler
 */
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Running scheduled incident check...');

    try {
      await processIncidents(env, false);
    } catch (error) {
      console.error('Error during scheduled check:', error);
      await updateMetrics(env.INCIDENTS_KV, {
        errors: 1,
      });
    }
  },

  // Handle HTTP requests (testing and health check)
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === '/health') {
      try {
        const metrics = await getMetrics(env.INCIDENTS_KV);
        return new Response(JSON.stringify({
          status: 'healthy',
          version: '2.0.0',
          metrics,
        }, null, 2), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        return new Response(JSON.stringify({
          status: 'unhealthy',
          error: error instanceof Error ? error.message : String(error),
        }, null, 2), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Manual trigger (for testing)
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const results = await processIncidents(env, true) as ProcessResult[];

      return new Response(JSON.stringify({
        message: 'Incident check completed',
        totalIncidents: results.length,
        results,
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      return new Response(JSON.stringify({
        error: 'Failed to process incidents',
        details: error instanceof Error ? error.message : String(error),
      }, null, 2), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
