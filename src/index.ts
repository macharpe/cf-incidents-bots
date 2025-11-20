/**
 * Cloudflare Worker to monitor Cloudflare Status page and post incidents to Google Chat
 */

// Environment bindings
interface Env {
  INCIDENTS_KV: KVNamespace;
  GOOGLE_CHAT_WEBHOOK: string;  // Secret
  STATUS_API_URL: string;        // Environment variable
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

/**
 * Fetch unresolved incidents from Cloudflare Status API
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
 * Get stored incident data from KV
 */
async function getStoredIncident(incidentId: string, kv: KVNamespace): Promise<StoredIncident | null> {
  const data = await kv.get(`incident:${incidentId}`);
  if (!data) return null;

  try {
    return JSON.parse(data) as StoredIncident;
  } catch {
    // Handle legacy format (just timestamp string) by treating as "identified" status
    return {
      status: 'identified',
      timestamp: data,
    };
  }
}

/**
 * Store incident data in KV
 */
async function storeIncident(incidentId: string, status: string, kv: KVNamespace): Promise<void> {
  const incidentData: StoredIncident = {
    status,
    timestamp: new Date().toISOString(),
  };

  // Store for 30 days (incidents older than this will be considered new if they reappear)
  await kv.put(`incident:${incidentId}`, JSON.stringify(incidentData), {
    expirationTtl: 30 * 24 * 60 * 60, // 30 days in seconds
  });
}

/**
 * Format and send incident notification to Google Chat
 */
async function sendGoogleChatNotification(incident: Incident, webhookUrl: string): Promise<void> {
  const color = IMPACT_COLORS[incident.impact] || IMPACT_COLORS.none;
  const emoji = IMPACT_EMOJIS[incident.impact] || IMPACT_EMOJIS.none;

  // Get the latest update
  const latestUpdate = incident.incident_updates[0];
  const updateBody = latestUpdate?.body || 'No details available';

  // Format the date
  const createdDate = new Date(incident.created_at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short'
  });

  // Build Google Chat card message
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

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to send Google Chat notification: ${response.status} ${response.statusText} - ${errorText}`);
    }

    console.log(`Notification sent for incident: ${incident.id} - ${incident.name}`);
  } catch (error) {
    console.error('Error sending Google Chat notification:', error);
    throw error;
  }
}

/**
 * Format and send incident resolution notification to Google Chat
 */
async function sendGoogleChatResolutionNotification(incident: Incident, webhookUrl: string): Promise<void> {
  const emoji = '✅';
  const color = '#4CAF50'; // Green

  // Get the resolution update
  const resolutionUpdate = incident.incident_updates.find(u => u.status === 'resolved');
  const resolutionBody = resolutionUpdate?.body || 'This incident has been resolved.';

  // Calculate incident duration (from when it started affecting users to resolution)
  const startTime = new Date(incident.started_at);
  const endTime = incident.resolved_at ? new Date(incident.resolved_at) : new Date();
  const durationMs = endTime.getTime() - startTime.getTime();
  const durationHours = Math.floor(durationMs / (1000 * 60 * 60));
  const durationMinutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
  const duration = durationHours > 0
    ? `${durationHours}h ${durationMinutes}m`
    : `${durationMinutes}m`;

  // Format the resolution date
  const resolvedDate = new Date(incident.resolved_at || incident.updated_at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short'
  });

  // Build Google Chat card message
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

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to send Google Chat resolution notification: ${response.status} ${response.statusText} - ${errorText}`);
    }

    console.log(`Resolution notification sent for incident: ${incident.id} - ${incident.name}`);
  } catch (error) {
    console.error('Error sending Google Chat resolution notification:', error);
    throw error;
  }
}

/**
 * Main scheduled event handler
 */
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Running scheduled incident check...');

    try {
      // Fetch all incidents (both active and resolved)
      const incidents = await fetchIncidents(env.STATUS_API_URL);
      console.log(`Found ${incidents.length} total incidents`);

      // Process each incident
      for (const incident of incidents) {
        const storedIncident = await getStoredIncident(incident.id, env.INCIDENTS_KV);

        if (!storedIncident) {
          // New incident - send notification only if it's not already resolved
          if (incident.status !== 'resolved') {
            console.log(`New incident detected: ${incident.id} - ${incident.name}`);
            await sendGoogleChatNotification(incident, env.GOOGLE_CHAT_WEBHOOK);
          }

          // Store the incident with its current status
          await storeIncident(incident.id, incident.status, env.INCIDENTS_KV);
        } else {
          // Existing incident - check if status changed to resolved
          if (storedIncident.status !== 'resolved' && incident.status === 'resolved') {
            console.log(`Incident resolved: ${incident.id} - ${incident.name}`);
            await sendGoogleChatResolutionNotification(incident, env.GOOGLE_CHAT_WEBHOOK);

            // Update stored status to resolved
            await storeIncident(incident.id, incident.status, env.INCIDENTS_KV);
          } else if (storedIncident.status !== incident.status) {
            // Status changed but not to resolved - just update KV
            console.log(`Incident status changed: ${incident.id} - ${storedIncident.status} -> ${incident.status}`);
            await storeIncident(incident.id, incident.status, env.INCIDENTS_KV);
          } else {
            console.log(`Incident unchanged: ${incident.id} - ${incident.name} (${incident.status})`);
          }
        }
      }

      console.log('Scheduled incident check completed');
    } catch (error) {
      console.error('Error during scheduled check:', error);
      // Don't throw - let the worker complete gracefully
    }
  },

  // Handle manual trigger via HTTP request (for testing)
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Only allow GET requests for manual testing
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      // Fetch all incidents (both active and resolved)
      const incidents = await fetchIncidents(env.STATUS_API_URL);

      // Process each incident
      const results = [];
      for (const incident of incidents) {
        const storedIncident = await getStoredIncident(incident.id, env.INCIDENTS_KV);

        const result: any = {
          id: incident.id,
          name: incident.name,
          impact: incident.impact,
          status: incident.status,
          storedStatus: storedIncident?.status || null,
          action: 'none',
        };

        if (!storedIncident) {
          // New incident - send notification only if not already resolved
          if (incident.status !== 'resolved') {
            result.action = 'new_incident_notification';
            await sendGoogleChatNotification(incident, env.GOOGLE_CHAT_WEBHOOK);
          }
          await storeIncident(incident.id, incident.status, env.INCIDENTS_KV);
        } else {
          // Existing incident - check if status changed to resolved
          if (storedIncident.status !== 'resolved' && incident.status === 'resolved') {
            result.action = 'resolution_notification';
            await sendGoogleChatResolutionNotification(incident, env.GOOGLE_CHAT_WEBHOOK);
            await storeIncident(incident.id, incident.status, env.INCIDENTS_KV);
          } else if (storedIncident.status !== incident.status) {
            result.action = 'status_updated';
            await storeIncident(incident.id, incident.status, env.INCIDENTS_KV);
          }
        }

        results.push(result);
      }

      return new Response(JSON.stringify({
        message: 'Incident check completed',
        totalIncidents: incidents.length,
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
