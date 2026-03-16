/**
 * SSH tool definitions and system prompt.
 *
 * Provides tools for executing commands on remote hosts via SSH
 * and managing interactive SSH sessions for read/write operations.
 *
 * All authentication credentials MUST come from the secret store.
 * The LLM must never read SSH keys, passwords, or credentials from
 * the filesystem. Use secret_save / secret_save_credential to store
 * them, then reference via {{secret:name}}.
 *
 * @module
 */

import type { ToolDefinition } from "../../core/types/tool.ts";

/** System prompt section for SSH tools. */
export const SSH_SYSTEM_PROMPT = `## SSH Tools

You have SSH tools for executing commands on remote hosts.

### Two Modes

1. **One-shot command** — \`ssh_execute\` runs a single command and returns stdout/stderr.
   Best for: quick lookups, status checks, file reads, simple operations.

2. **Interactive session** — \`ssh_session_open\` opens a persistent connection.
   Use \`ssh_session_write\` to send commands and \`ssh_session_read\` to read output.
   Close with \`ssh_session_close\` when done.
   Best for: multi-step operations, stateful work (cd then run), long-running tasks.

### Authentication — SECRETS ONLY

**CRITICAL: You must NEVER read, access, or reference files in ~/.ssh/ or any other filesystem path for SSH credentials. ALL authentication credentials MUST come from the secret store via {{secret:name}} references.**

SSH tools support three credential combinations, all via secret references:

1. **Key-based auth** — Store a private key with \`secret_save\`, then pass:
   \`key: "{{secret:my_ssh_key}}"\`

2. **Password auth** — Store a credential with \`secret_save_credential\`, then pass:
   \`password: "{{secret:my_ssh:password}}"\`

3. **Key + passphrase** — Store the key with \`secret_save\` and the passphrase separately, then pass both:
   \`key: "{{secret:my_ssh_key}}", passphrase: "{{secret:my_key_passphrase}}"\`

The username can be part of the host (\`user@hostname\`) or stored as a secret:
\`host: "{{secret:my_ssh:username}}@server.example.com"\`

### Setup Flow

When a user asks to SSH somewhere and no credentials exist:
1. Call \`secret_list\` to check for existing SSH credentials.
2. If none found, ask the user which auth method they want (key or password).
3. Use \`secret_save\` (for a key) or \`secret_save_credential\` (for username/password) to store credentials.
4. Then call \`ssh_execute\` or \`ssh_session_open\` with the appropriate \`{{secret:...}}\` references.

**Never use read_file, list_directory, or any filesystem tool to find or read SSH keys. Never reference ~/.ssh/ paths. This is a security violation.**

### Guidelines

- Prefer \`ssh_execute\` for single commands — it is simpler and self-contained.
- Use interactive sessions when you need to maintain state across commands.
- Always close sessions when done to free resources.
- The \`host\` parameter accepts standard SSH formats: \`user@hostname\`, \`hostname\`, or SSH config aliases.
`;

/** Build the ssh_execute tool definition. */
function buildSshExecuteDef(): ToolDefinition {
  return {
    name: "ssh_execute",
    description:
      "Execute a single command on a remote host via SSH and return the output. " +
      "Authentication credentials MUST come from the secret store via {{secret:name}} references. " +
      "Never read SSH keys from the filesystem.",
    parameters: {
      host: {
        type: "string",
        description:
          "SSH host to connect to. Accepts user@hostname, hostname, or SSH config alias. " +
          "The username can be a {{secret:name}} reference.",
        required: true,
      },
      command: {
        type: "string",
        description: "The command to execute on the remote host.",
        required: true,
      },
      key: {
        type: "string",
        description: "SSH private key content from the secret store. " +
          "Use a {{secret:name}} reference (e.g. {{secret:prod_ssh_key}}). " +
          "Never pass a filesystem path or read keys from disk.",
      },
      password: {
        type: "string",
        description:
          "SSH password from the secret store for password-based authentication. " +
          "Use a {{secret:name}} reference (e.g. {{secret:prod_ssh:password}}).",
      },
      passphrase: {
        type: "string",
        description:
          "Passphrase for an encrypted SSH private key, from the secret store. " +
          "Use a {{secret:name}} reference. Only used together with the 'key' parameter.",
      },
      timeout_ms: {
        type: "number",
        description:
          "Maximum execution time in milliseconds. Defaults to 30000 (30 seconds).",
      },
      port: {
        type: "number",
        description:
          "SSH port number. Defaults to the SSH config default (usually 22).",
      },
    },
  };
}

/** Build the ssh_session_open tool definition. */
function buildSshSessionOpenDef(): ToolDefinition {
  return {
    name: "ssh_session_open",
    description:
      "Open a persistent interactive SSH session to a remote host. " +
      "Returns a session ID for use with ssh_session_write and ssh_session_read. " +
      "Close with ssh_session_close when done. " +
      "Authentication credentials MUST come from the secret store via {{secret:name}} references.",
    parameters: {
      host: {
        type: "string",
        description:
          "SSH host to connect to. Accepts user@hostname, hostname, or SSH config alias. " +
          "The username can be a {{secret:name}} reference.",
        required: true,
      },
      key: {
        type: "string",
        description: "SSH private key content from the secret store. " +
          "Use a {{secret:name}} reference (e.g. {{secret:prod_ssh_key}}). " +
          "Never pass a filesystem path or read keys from disk.",
      },
      password: {
        type: "string",
        description:
          "SSH password from the secret store for password-based authentication. " +
          "Use a {{secret:name}} reference (e.g. {{secret:prod_ssh:password}}).",
      },
      passphrase: {
        type: "string",
        description:
          "Passphrase for an encrypted SSH private key, from the secret store. " +
          "Use a {{secret:name}} reference. Only used together with the 'key' parameter.",
      },
      port: {
        type: "number",
        description:
          "SSH port number. Defaults to the SSH config default (usually 22).",
      },
    },
  };
}

/** Build the ssh_session_write tool definition. */
function buildSshSessionWriteDef(): ToolDefinition {
  return {
    name: "ssh_session_write",
    description: "Write input to an open interactive SSH session. " +
      "The input is sent to the remote shell's stdin. " +
      "A newline is appended automatically unless the input already ends with one.",
    parameters: {
      session_id: {
        type: "string",
        description: "The session ID returned by ssh_session_open.",
        required: true,
      },
      input: {
        type: "string",
        description: "The text to send to the remote shell's stdin.",
        required: true,
      },
    },
  };
}

/** Build the ssh_session_read tool definition. */
function buildSshSessionReadDef(): ToolDefinition {
  return {
    name: "ssh_session_read",
    description: "Read buffered output from an open interactive SSH session. " +
      "Returns all stdout and stderr accumulated since the last read. " +
      "If no output is available yet, waits briefly before returning.",
    parameters: {
      session_id: {
        type: "string",
        description: "The session ID returned by ssh_session_open.",
        required: true,
      },
      timeout_ms: {
        type: "number",
        description:
          "Maximum time to wait for output in milliseconds. Defaults to 5000 (5 seconds).",
      },
    },
  };
}

/** Build the ssh_session_close tool definition. */
function buildSshSessionCloseDef(): ToolDefinition {
  return {
    name: "ssh_session_close",
    description: "Close an open interactive SSH session and free resources. " +
      "Returns any remaining buffered output.",
    parameters: {
      session_id: {
        type: "string",
        description: "The session ID returned by ssh_session_open.",
        required: true,
      },
    },
  };
}

/** Get all SSH tool definitions. */
export function buildSshToolDefinitions(): ToolDefinition[] {
  return [
    buildSshExecuteDef(),
    buildSshSessionOpenDef(),
    buildSshSessionWriteDef(),
    buildSshSessionReadDef(),
    buildSshSessionCloseDef(),
  ];
}

/** @deprecated Use buildSshToolDefinitions instead */
export const getSshToolDefinitions = buildSshToolDefinitions;
