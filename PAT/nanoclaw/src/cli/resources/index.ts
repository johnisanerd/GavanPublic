/**
 * Resource barrel — imports each resource module for its side-effect
 * `registerResource(...)` call.
 */
import './groups.js';
import './messaging-groups.js';
import './wirings.js';
import './users.js';
import './roles.js';
import './members.js';
import './destinations.js';
import './policies.js';
import './user-dms.js';
import './dropped-messages.js';
import './approvals.js';
import './sessions.js';
import './people.js'; // PAT: people spine
import './person-roles.js'; // PAT: dashboard data-visibility roles
import './conversations.js'; // PAT: conversation recall
import './channel-registrations.js'; // PAT: list/approve pending registration cards
import './pairing-codes.js'; // PAT: self-service handle linking by pairing code
import './credentials.js'; // PAT: credential routing + vault reconcile (metadata only, never values)
import './files.js'; // PAT: publish_file — signed expiring public file URLs
