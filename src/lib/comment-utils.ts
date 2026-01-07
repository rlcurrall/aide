import { convert, type ConversionResult } from './adf-to-md.js';
import type { AdfInput, AdfNode, JiraComment } from './types.js';

export interface CommentFilter {
  author?: string;
  sinceDate?: string;
  latest?: number;
}

export interface FormattedComment {
  id: string;
  author: string;
  authorEmail?: string;
  created: string;
  updated: string;
  body: string;
  raw?: JiraComment;
}

export function convertAdfToMarkdown(adfContent: AdfInput): string {
  if (!adfContent) {
    return '';
  }

  // Handle different ADF content structures
  if (typeof adfContent === 'string') {
    return adfContent;
  }

  try {
    // Use adf-to-md library for proper conversion
    const result: ConversionResult = convert(adfContent);
    // adf-to-md returns an object with result and warnings properties
    return result.result;
  } catch (error) {
    // Fallback to simple text extraction if conversion fails
    console.warn(
      'ADF to markdown conversion failed, using fallback:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    return extractTextFromAdf(adfContent);
  }
}

function extractTextFromAdf(content: AdfInput): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!content || !content.content || !Array.isArray(content.content)) {
    return '';
  }

  return content.content
    .map((item: AdfNode) => {
      if (item.text) return item.text;
      if (item.content && Array.isArray(item.content)) {
        return item.content
          .map((subItem: AdfNode) => subItem.text || '')
          .join('');
      }
      return '';
    })
    .join('');
}

export function formatComment(
  comment: JiraComment,
  format: 'text' | 'json' | 'markdown' = 'text'
): string {
  const formattedComment: FormattedComment = {
    id: comment.id,
    author: comment.author.displayName,
    authorEmail: comment.author.emailAddress,
    created: comment.created,
    updated: comment.updated,
    body: convertAdfToMarkdown(comment.body),
    raw: format === 'json' ? comment : undefined,
  };

  switch (format) {
    case 'json':
      return JSON.stringify(formattedComment, null, 2);

    case 'markdown':
      return `## Comment by ${formattedComment.author}
**Date:** ${formattedComment.created.substring(0, 19).replace('T', ' ')}
**ID:** ${formattedComment.id}

${formattedComment.body}

---`;

    case 'text':
    default:
      return `[${formattedComment.created.substring(0, 10)}] ${
        formattedComment.author
      }:
${formattedComment.body}`;
  }
}

export function filterComments(
  comments: JiraComment[],
  filter: CommentFilter
): JiraComment[] {
  let filtered = [...comments];

  // Filter by author
  if (filter.author) {
    const authorLower = filter.author.toLowerCase();
    filtered = filtered.filter(
      (comment) =>
        comment.author.displayName.toLowerCase().includes(authorLower) ||
        comment.author.emailAddress?.toLowerCase().includes(authorLower)
    );
  }

  // Filter by date
  if (filter.sinceDate) {
    const sinceDate = new Date(filter.sinceDate);
    filtered = filtered.filter(
      (comment) => new Date(comment.created) >= sinceDate
    );
  }

  // Limit to latest N comments
  if (filter.latest && filter.latest > 0) {
    // Sort by created date (newest first) and take the latest N
    filtered.sort(
      (a, b) => new Date(b.created).getTime() - new Date(a.created).getTime()
    );
    filtered = filtered.slice(0, filter.latest);
  }

  return filtered;
}

export function formatCommentsOutput(
  comments: JiraComment[],
  format: 'text' | 'json' | 'markdown' = 'text',
  issueKey?: string
): string {
  if (!comments || comments.length === 0) {
    return format === 'json' ? '[]' : 'No comments found.';
  }

  if (format === 'json') {
    return JSON.stringify(
      comments.map((comment) => ({
        id: comment.id,
        author: comment.author.displayName,
        authorEmail: comment.author.emailAddress,
        created: comment.created,
        updated: comment.updated,
        body: convertAdfToMarkdown(comment.body),
      })),
      null,
      2
    );
  }

  let output = '';

  if (format === 'markdown') {
    output += `# Comments for ${issueKey || 'Issue'}\n\n`;
    output += `Found ${comments.length} comment${
      comments.length !== 1 ? 's' : ''
    }:\n\n`;
  } else {
    output += `Found ${comments.length} comment${
      comments.length !== 1 ? 's' : ''
    }:\n\n`;
  }

  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i];
    if (comment) {
      output += formatComment(comment, format);
      if (i < comments.length - 1) {
        output += '\n\n';
      }
    }
  }

  return output;
}
