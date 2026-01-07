/**
 * Markdown to ADF Converter
 *
 * Converts Markdown to Atlassian Document Format (ADF)
 * Based on https://github.com/jamsinclair/marklassian
 * Vendored and modernized for TypeScript with direct `marked` usage
 */

import { marked, type Token } from 'marked';

interface AdfNode {
  type: string;
  content?: AdfNode[];
  attrs?: Record<string, any>;
  text?: string;
  marks?: AdfMark[];
  version?: number;
}

interface AdfMark {
  type: string;
  attrs?: Record<string, any>;
}

function generateLocalId(): string {
  // Simple UUID v4 generator for local IDs
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function tokensToAdf(tokens: Token[]): AdfNode[] {
  const result: AdfNode[] = [];

  for (const token of tokens) {
    const adfNode = tokenToAdf(token);
    if (adfNode) {
      result.push(adfNode);
    }
  }

  return result;
}

function tokenToAdf(token: Token): AdfNode | null {
  switch (token.type) {
    case 'paragraph':
      return {
        type: 'paragraph',
        content: inlineToAdf(token.tokens || []),
      };

    case 'heading':
      return {
        type: 'heading',
        attrs: { level: token.depth },
        content: inlineToAdf(token.tokens || []),
      };

    case 'code':
      return {
        type: 'codeBlock',
        attrs: {
          language: token.lang || null,
          localId: generateLocalId(),
        },
        content: [{ type: 'text', text: token.text }],
      };

    case 'blockquote':
      const blockTokens = marked.lexer(token.text);
      return {
        type: 'blockquote',
        content: tokensToAdf(blockTokens),
      };

    case 'list':
      return {
        type: token.ordered ? 'orderedList' : 'bulletList',
        attrs: { order: token.ordered ? 1 : undefined },
        content: token.items.map((item: any) => processListItem(item)),
      };

    case 'table':
      const headerRow: AdfNode = {
        type: 'tableRow',
        content: token.header.map((cell: any) => ({
          type: 'tableHeader',
          attrs: {},
          content: inlineToAdf(cell.tokens || []),
        })),
      };

      const bodyRows = token.rows.map((row: any) => ({
        type: 'tableRow',
        content: row.map((cell: any) => ({
          type: 'tableCell',
          attrs: {},
          content: inlineToAdf(cell.tokens || []),
        })),
      }));

      return {
        type: 'table',
        attrs: { isNumberColumnEnabled: false, layout: 'default' },
        content: [headerRow, ...bodyRows],
      };

    case 'hr':
      return {
        type: 'rule',
      };

    case 'space':
      return null; // Skip whitespace tokens

    default:
      // For any other token types, try to extract text content
      if ('text' in token && typeof token.text === 'string') {
        return {
          type: 'paragraph',
          content: [{ type: 'text', text: token.text }],
        };
      }
      return null;
  }
}

function processListItem(item: any): AdfNode {
  const itemTokens = marked.lexer(item.text);

  // Check if this is a task list item
  const taskMatch = item.text.match(/^(\[[ x]\])\s*(.*)/);
  if (taskMatch) {
    const isChecked = taskMatch[1] === '[x]';
    const taskText = taskMatch[2];
    const taskTokens = marked.lexer(taskText);

    return {
      type: 'taskItem',
      attrs: {
        localId: generateLocalId(),
        state: isChecked ? 'DONE' : 'TODO',
      },
      content: tokensToAdf(taskTokens),
    };
  }

  return {
    type: 'listItem',
    content: tokensToAdf(itemTokens),
  };
}

function inlineToAdf(tokens: Token[]): AdfNode[] {
  const result: AdfNode[] = [];

  for (const token of tokens) {
    const adfNodes = inlineTokenToAdf(token);
    result.push(...adfNodes);
  }

  return result;
}

function inlineTokenToAdf(token: Token): AdfNode[] {
  switch (token.type) {
    case 'text':
      return [{ type: 'text', text: token.text }];

    case 'strong':
      return [
        {
          type: 'text',
          text: token.text,
          marks: [{ type: 'strong' }],
        },
      ];

    case 'em':
      return [
        {
          type: 'text',
          text: token.text,
          marks: [{ type: 'em' }],
        },
      ];

    case 'codespan':
      return [
        {
          type: 'text',
          text: token.text,
          marks: [{ type: 'code' }],
        },
      ];

    case 'del':
      return [
        {
          type: 'text',
          text: token.text,
          marks: [{ type: 'strike' }],
        },
      ];

    case 'link':
      const linkContent: AdfNode[] = token.tokens
        ? inlineToAdf(token.tokens)
        : [{ type: 'text', text: token.text, marks: [] }];
      return linkContent.map((node) => {
        const linkNode: AdfNode = {
          type: node.type,
          text: node.text,
          marks: [
            ...(node.marks || []),
            { type: 'link', attrs: { href: token.href, title: token.title } },
          ],
        };
        if (node.content) linkNode.content = node.content;
        if (node.attrs) linkNode.attrs = node.attrs;
        return linkNode;
      });

    case 'image':
      // Convert images to inline cards for now
      return [
        {
          type: 'text',
          text: token.text || token.href,
          marks: [
            {
              type: 'link',
              attrs: { href: token.href, title: token.title },
            },
          ],
        },
      ];

    case 'br':
      return [{ type: 'hardBreak' }];

    default:
      // Fallback for unknown inline tokens
      if ('text' in token && typeof token.text === 'string') {
        return [{ type: 'text', text: token.text }];
      }
      return [];
  }
}

export function convert(markdown: string): AdfNode {
  if (!markdown || typeof markdown !== 'string') {
    return {
      type: 'doc',
      version: 1,
      content: [],
    };
  }

  try {
    const tokens = marked.lexer(markdown.trim());
    const content = tokensToAdf(tokens);

    return {
      type: 'doc',
      version: 1,
      content,
    };
  } catch {
    // Fallback to plain text paragraph if parsing fails
    return {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: markdown,
            },
          ],
        },
      ],
    };
  }
}

export default { convert };
