/**
 * ADF to Markdown Converter
 *
 * Converts Atlassian Document Format (ADF) to Markdown
 * Based on https://github.com/julianlam/adf-to-md
 * Vendored and modernized for TypeScript
 */

export interface ConversionResult {
  result: string;
  warnings: Record<string, string[]>;
}

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

function convertNode(
  node: AdfNode,
  warnings: Record<string, string[]>
): string {
  const content = node.content || [];

  switch (node.type) {
    case 'doc':
      return content.map((child) => convertNode(child, warnings)).join('\n\n');

    case 'text':
      return convertMarks(node, warnings);

    case 'paragraph':
      return content.map((child) => convertNode(child, warnings)).join('');

    case 'heading':
      const level = node.attrs?.level || 1;
      const headingText = content
        .map((child) => convertNode(child, warnings))
        .join('');
      return `${'#'.repeat(level)} ${headingText}`;

    case 'hardBreak':
      return '\n';

    case 'inlineCard':
    case 'blockCard':
    case 'embedCard':
      const url = node.attrs?.url || '#';
      return `[${url}](${url})`;

    case 'blockquote':
      const blockContent = content
        .map((child) => convertNode(child, warnings))
        .join('\n> ');
      return `> ${blockContent}`;

    case 'codeBlock':
      const language = node.attrs?.language || '';
      const codeContent = content
        .map((child) => convertNode(child, warnings))
        .join('');
      return `\`\`\`${language}\n${codeContent}\n\`\`\``;

    case 'orderedList':
      return content
        .map((child, index) => {
          const itemContent = convertNode(child, warnings);
          return `${index + 1}. ${itemContent}`;
        })
        .join('\n');

    case 'bulletList':
      return content
        .map((child) => {
          const itemContent = convertNode(child, warnings);
          return `- ${itemContent}`;
        })
        .join('\n');

    case 'listItem':
      return content.map((child) => convertNode(child, warnings)).join('\n');

    case 'table':
      const rows = content.map((child) => convertNode(child, warnings));
      if (rows.length === 0) return '';

      // Add table header separator
      const headerRow = rows[0];
      if (!headerRow) return '';
      const columnCount = (headerRow.match(/\|/g) || []).length - 1;
      const separator = '|' + ':-:|'.repeat(columnCount);

      return [headerRow, separator, ...rows.slice(1)].join('\n');

    case 'tableRow':
      const cells = content.map((child) => convertNode(child, warnings));
      return `|${cells.join('|')}|`;

    case 'tableCell':
    case 'tableHeader':
      return content.map((child) => convertNode(child, warnings)).join('');

    case 'rule':
      return '---';

    case 'taskList':
      addWarning(
        warnings,
        'taskList',
        'Task lists may not render exactly as in Jira'
      );
      return content.map((child) => convertNode(child, warnings)).join('\n');

    case 'taskItem':
      const isChecked = node.attrs?.state === 'DONE';
      const taskContent = content
        .map((child) => convertNode(child, warnings))
        .join('');
      return `- [${isChecked ? 'x' : ' '}] ${taskContent}`;

    case 'mediaGroup':
    case 'media':
      // Media nodes are complex - just return a placeholder
      addWarning(
        warnings,
        'media',
        'Media attachments converted to placeholder'
      );
      return '[Media attachment]';

    default:
      addWarning(warnings, node.type, `Unsupported node type: ${node.type}`);
      return content.map((child) => convertNode(child, warnings)).join('');
  }
}

function convertMarks(
  node: AdfNode,
  warnings: Record<string, string[]>
): string {
  let text = node.text || '';

  if (!node.marks || node.marks.length === 0) {
    return text;
  }

  for (const mark of node.marks) {
    switch (mark.type) {
      case 'strong':
        text = `**${text}**`;
        break;

      case 'em':
        text = `*${text}*`;
        break;

      case 'code':
        text = `\`${text}\``;
        break;

      case 'strike':
        text = `~~${text}~~`;
        break;

      case 'link':
        const href = mark.attrs?.href || '#';
        text = `[${text}](${href})`;
        break;

      case 'underline':
        // Markdown doesn't have native underline, use emphasis instead
        text = `*${text}*`;
        addWarning(warnings, 'underline', 'Underline converted to emphasis');
        break;

      case 'textColor':
        // Markdown doesn't support text colors - preserve text only
        addWarning(warnings, 'textColor', 'Text color formatting removed');
        break;

      default:
        addWarning(warnings, mark.type, `Unsupported mark type: ${mark.type}`);
        break;
    }
  }

  return text;
}

function addWarning(
  warnings: Record<string, string[]>,
  type: string,
  message: string
): void {
  if (!warnings[type]) {
    warnings[type] = [];
  }
  if (!warnings[type].includes(message)) {
    warnings[type].push(message);
  }
}

function validateInput(adf: any): void {
  if (!adf || typeof adf !== 'object') {
    throw new Error('Input must be a valid ADF object');
  }

  if (adf.type !== 'doc') {
    throw new Error('ADF must have a root "doc" node');
  }
}

export function convert(adf: any): ConversionResult {
  const warnings: Record<string, string[]> = {};

  try {
    validateInput(adf);
    const result = convertNode(adf, warnings);

    return {
      result: result.trim(),
      warnings,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown conversion error';
    return {
      result: '',
      warnings: {
        error: [message],
      },
    };
  }
}

export default { convert };
