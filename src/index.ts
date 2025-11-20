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
  shortlink: string;
  incident_updates: IncidentUpdate[];
}

interface IncidentUpdate {
  body: string;
  status: string;
  created_at: string;
  display_at: string;
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
 * Check if an incident has already been reported
 */
async function isIncidentReported(incidentId: string, kv: KVNamespace): Promise<boolean> {
  const reported = await kv.get(`incident:${incidentId}`);
  return reported !== null;
}

/**
 * Mark an incident as reported
 */
async function markIncidentReported(incidentId: string, kv: KVNamespace): Promise<void> {
  // Store for 30 days (incidents older than this will be considered new if they reappear)
  await kv.put(`incident:${incidentId}`, new Date().toISOString(), {
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
 * Main scheduled event handler
 */
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Running scheduled incident check...');

    try {
      // Fetch current unresolved incidents
      const incidents = await fetchIncidents(env.STATUS_API_URL);
      console.log(`Found ${incidents.length} unresolved incidents`);

      // Process each incident
      for (const incident of incidents) {
        // Check if we've already reported this incident
        const alreadyReported = await isIncidentReported(incident.id, env.INCIDENTS_KV);

        if (!alreadyReported) {
          console.log(`New incident detected: ${incident.id} - ${incident.name}`);

          // Send notification to Google Chat
          await sendGoogleChatNotification(incident, env.GOOGLE_CHAT_WEBHOOK);

          // Mark as reported
          await markIncidentReported(incident.id, env.INCIDENTS_KV);
        } else {
          console.log(`Incident already reported: ${incident.id} - ${incident.name}`);
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
      // Fetch current unresolved incidents
      const incidents = await fetchIncidents(env.STATUS_API_URL);

      // Process each incident
      const results = [];
      for (const incident of incidents) {
        const alreadyReported = await isIncidentReported(incident.id, env.INCIDENTS_KV);

        results.push({
          id: incident.id,
          name: incident.name,
          impact: incident.impact,
          status: incident.status,
          alreadyReported,
        });

        if (!alreadyReported) {
          await sendGoogleChatNotification(incident, env.GOOGLE_CHAT_WEBHOOK);
          await markIncidentReported(incident.id, env.INCIDENTS_KV);
        }
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
