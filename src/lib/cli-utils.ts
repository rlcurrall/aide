export function parseArgs(args: string[]): {
  query?: string;
  maxResults?: number;
  help?: boolean;
} {
  const result: { query?: string; maxResults?: number; help?: boolean } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue; // Skip undefined values

    if (arg === '-h' || arg === '--help') {
      result.help = true;
    } else if (!result.query) {
      result.query = arg;
    } else if (!result.maxResults && /^\d+$/.test(arg)) {
      result.maxResults = parseInt(arg, 10);
    }
  }

  return result;
}

export function parseTicketArgs(args: string[]): {
  ticketKey?: string;
  help?: boolean;
} {
  const result: { ticketKey?: string; help?: boolean } = {};

  for (const arg of args) {
    if (arg === '-h' || arg === '--help') {
      result.help = true;
    } else if (!result.ticketKey) {
      result.ticketKey = arg;
    }
  }

  return result;
}

export function formatSearchResults(response: any): string {
  if (response.errorMessages || response.errors) {
    return `Error: ${response.errorMessages?.join(', ') || JSON.stringify(response.errors)}`;
  }

  if (!response.issues || response.issues.length === 0) {
    return 'No issues found.';
  }

  const total = response.total || response.issues.length;
  const showing = response.issues.length;

  let output = `Found ${total} issues (showing ${showing}):\n\n`;

  for (const issue of response.issues) {
    output += `[${issue.key}] ${issue.fields.summary}\n`;
    output += `  Status: ${issue.fields.status.name}\n`;
    output += `  Assignee: ${issue.fields.assignee?.displayName || 'Unassigned'}\n`;
    output += `  Priority: ${issue.fields.priority.name}\n`;
    output += `  Created: ${issue.fields.created.substring(0, 10)}\n`;
    output += `  Updated: ${issue.fields.updated.substring(0, 10)}\n`;
    output += '\n';
  }

  return output.trimEnd();
}

function extractTextFromContent(content: any): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!content?.content || !Array.isArray(content.content)) {
    return '';
  }

  return content.content
    .map((item: any) => {
      if (item.text) return item.text;
      if (item.content && Array.isArray(item.content)) {
        return item.content.map((subItem: any) => subItem.text || '').join('');
      }
      return '';
    })
    .join('');
}

export function formatTicketDetails(issue: any): string {
  if (issue.errorMessages || issue.errors) {
    return `Error: ${issue.errorMessages?.join(', ') || JSON.stringify(issue.errors) || 'Ticket not found or access denied'}`;
  }

  if (!issue.key) {
    return 'Error: Ticket not found or access denied';
  }

  let output = `=== ${issue.key}: ${issue.fields.summary} ===\n\n`;

  output += `Project: ${issue.fields.project.name} (${issue.fields.project.key})\n`;
  output += `Issue Type: ${issue.fields.issuetype.name}\n`;
  output += `Status: ${issue.fields.status.name}\n`;
  output += `Priority: ${issue.fields.priority.name}\n`;
  output += `Reporter: ${issue.fields.reporter.displayName}\n`;
  output += `Assignee: ${issue.fields.assignee?.displayName || 'Unassigned'}\n`;
  output += `Created: ${issue.fields.created}\n`;
  output += `Updated: ${issue.fields.updated}\n`;

  if (issue.fields.resolutiondate) {
    output += `Resolved: ${issue.fields.resolutiondate}\n`;
  }

  output += '\nDescription:\n';
  output += '------------\n';

  const description = extractTextFromContent(issue.fields.description);
  output += description || 'No description';
  output += '\n\n';

  // Attachments
  if (issue.fields.attachment && issue.fields.attachment.length > 0) {
    output += 'Attachments:\n';
    output += '------------\n';

    for (const attachment of issue.fields.attachment) {
      output += `- ${attachment.filename} (${attachment.size} bytes) by ${attachment.author.displayName} on ${attachment.created.substring(0, 10)}\n`;
    }
    output += '\n';
  }

  // Subtasks
  if (issue.fields.subtasks && issue.fields.subtasks.length > 0) {
    output += 'Subtasks:\n';
    output += '---------\n';

    for (const subtask of issue.fields.subtasks) {
      output += `- [${subtask.key}] ${subtask.fields.summary} (${subtask.fields.status.name})\n`;
    }
    output += '\n';
  }

  return output.trimEnd();
}

export function validateTicketKey(ticketKey: string): {
  valid: boolean;
  warning?: string;
} {
  const ticketPattern = /^[A-Z]+-\d+$/;

  if (!ticketPattern.test(ticketKey)) {
    return {
      valid: false,
      warning: `Warning: '${ticketKey}' doesn't match typical Jira ticket format (PROJECT-123)`,
    };
  }

  return { valid: true };
}
