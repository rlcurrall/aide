/**
 * Jira attach command
 * Manage attachments on Jira tickets
 */

import type { ArgumentsCamelCase, CommandModule } from 'yargs';
import { loadConfig } from '@lib/config.js';
import { JiraClient } from '@lib/jira-client.js';
import { validateArgs } from '@lib/validation.js';
import { AttachArgsSchema, type AttachArgs } from '@schemas/jira/attach.js';
import { handleCommandError } from '@lib/errors.js';
import { validateTicketKeyWithWarning, logProgress } from '@lib/jira-utils.js';
import type { JiraAttachment } from '@lib/types.js';
import path from 'path';

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAttachmentsText(attachments: JiraAttachment[]): string {
  if (attachments.length === 0) {
    return 'No attachments on this ticket.';
  }

  const lines = ['Attachments:', ''];
  for (const a of attachments) {
    lines.push(`  ${a.filename}`);
    lines.push(`    Size: ${formatAttachmentSize(a.size)}`);
    lines.push(`    Type: ${a.mimeType}`);
    lines.push(`    Author: ${a.author.displayName}`);
    lines.push(`    Created: ${a.created}`);
    lines.push('');
  }
  return lines.join('\n');
}

function formatAttachmentsMarkdown(attachments: JiraAttachment[]): string {
  if (attachments.length === 0) {
    return '## Attachments\n\nNo attachments on this ticket.';
  }

  const lines = ['## Attachments', ''];
  for (const a of attachments) {
    lines.push(`### ${a.filename}`);
    lines.push(`- **Size:** ${formatAttachmentSize(a.size)}`);
    lines.push(`- **Type:** ${a.mimeType}`);
    lines.push(`- **Author:** ${a.author.displayName}`);
    lines.push(`- **Created:** ${a.created}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function handler(argv: ArgumentsCamelCase<AttachArgs>): Promise<void> {
  const args = validateArgs(AttachArgsSchema, argv, 'attach arguments');
  const { ticketKey, format } = args;

  // Validate ticket key format (soft validation with warning)
  validateTicketKeyWithWarning(ticketKey);

  // Check that exactly one operation is specified
  const operations = [
    args.list,
    args.upload && args.upload.length > 0,
    args.download,
    args.delete,
  ].filter(Boolean);

  if (operations.length === 0) {
    console.error(
      'Error: Specify an operation: --list, --upload, --download, or --delete'
    );
    process.exit(1);
  }

  if (operations.length > 1) {
    console.error('Error: Only one operation can be performed at a time');
    process.exit(1);
  }

  try {
    const config = loadConfig();
    const client = new JiraClient(config);

    // List attachments
    if (args.list) {
      logProgress(`Fetching attachments for: ${ticketKey}`, format);
      logProgress('', format);

      const issue = await client.getIssue(ticketKey);
      const attachments = issue.fields.attachment || [];

      if (format === 'json') {
        console.log(JSON.stringify(attachments, null, 2));
      } else if (format === 'markdown') {
        console.log(formatAttachmentsMarkdown(attachments));
      } else {
        console.log(formatAttachmentsText(attachments));
      }
      return;
    }

    // Upload attachments
    if (args.upload && args.upload.length > 0) {
      logProgress(
        `Uploading ${args.upload.length} file(s) to: ${ticketKey}`,
        format
      );
      logProgress('', format);

      const results = [];
      for (const filePath of args.upload) {
        logProgress(`Uploading: ${filePath}...`, format);
        const uploaded = await client.uploadAttachment(ticketKey, filePath);
        results.push(...uploaded);
      }

      if (format === 'json') {
        console.log(JSON.stringify(results, null, 2));
      } else {
        console.log(`Successfully uploaded ${results.length} file(s):`);
        for (const r of results) {
          console.log(`  ${r.filename} (${formatAttachmentSize(r.size)})`);
        }
        console.log('');
        console.log(`View ticket: ${config.url}/browse/${ticketKey}`);
      }
      return;
    }

    // Download attachment
    if (args.download) {
      logProgress(`Fetching attachments for: ${ticketKey}`, format);

      const issue = await client.getIssue(ticketKey);
      const attachments = issue.fields.attachment || [];

      // Find attachment by ID or filename
      const attachment = attachments.find(
        (a) =>
          a.id === args.download ||
          a.filename === args.download ||
          a.filename.toLowerCase() === args.download?.toLowerCase()
      );

      if (!attachment) {
        console.error(`Error: Attachment '${args.download}' not found`);
        console.error('');
        console.error('Available attachments:');
        for (const a of attachments) {
          console.error(`  ${a.id}: ${a.filename}`);
        }
        process.exit(1);
      }

      const attachmentId = attachment.id;

      const outputPath = args.output
        ? path.join(args.output, attachment.filename)
        : attachment.filename;

      logProgress(`Downloading: ${attachment.filename}...`, format);
      await client.downloadAttachment(attachmentId, outputPath);

      if (format === 'json') {
        console.log(
          JSON.stringify(
            {
              success: true,
              filename: attachment.filename,
              size: attachment.size,
              outputPath,
            },
            null,
            2
          )
        );
      } else {
        console.log(`Downloaded: ${outputPath}`);
        console.log(`Size: ${formatAttachmentSize(attachment.size)}`);
      }
      return;
    }

    // Delete attachment
    if (args.delete) {
      logProgress(`Fetching attachments for: ${ticketKey}`, format);

      const issue = await client.getIssue(ticketKey);
      const attachments = issue.fields.attachment || [];

      // Find attachment by ID or filename
      const attachment = attachments.find(
        (a) =>
          a.id === args.delete ||
          a.filename === args.delete ||
          a.filename.toLowerCase() === args.delete?.toLowerCase()
      );

      if (!attachment) {
        console.error(`Error: Attachment '${args.delete}' not found`);
        console.error('');
        console.error('Available attachments:');
        for (const a of attachments) {
          console.error(`  ${a.id}: ${a.filename}`);
        }
        process.exit(1);
      }

      const attachmentId = attachment.id;

      logProgress(`Deleting: ${attachment.filename}...`, format);
      await client.deleteAttachment(attachmentId);

      if (format === 'json') {
        console.log(
          JSON.stringify(
            {
              success: true,
              deleted: attachment.filename,
              attachmentId,
            },
            null,
            2
          )
        );
      } else {
        console.log(`Deleted: ${attachment.filename}`);
      }
      return;
    }
  } catch (error) {
    handleCommandError(error);
  }
}

export default {
  command: 'attach <ticketKey>',
  describe: 'Manage ticket attachments',
  builder: {
    ticketKey: {
      type: 'string',
      describe: 'Jira ticket key (e.g., PROJ-123)',
      demandOption: true,
    },
    upload: {
      type: 'string',
      alias: 'u',
      array: true,
      describe: 'Upload file(s) to ticket',
    },
    download: {
      type: 'string',
      alias: 'd',
      describe: 'Download attachment by ID or filename',
    },
    output: {
      type: 'string',
      alias: 'o',
      describe: 'Output directory for downloads (default: current directory)',
    },
    list: {
      type: 'boolean',
      alias: 'l',
      describe: 'List all attachments',
      default: false,
    },
    delete: {
      type: 'string',
      describe: 'Delete attachment by ID or filename',
    },
    format: {
      type: 'string',
      choices: ['text', 'json', 'markdown'] as const,
      default: 'text' as const,
      describe: 'Output format',
    },
  },
  handler,
} satisfies CommandModule<object, AttachArgs>;
