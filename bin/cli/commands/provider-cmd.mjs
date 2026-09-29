export function registerProvider(program) {
  program
    .command("provider [subcommand]")
    .description("Manage provider connections (use 'providers' for the full interface)")
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      console.log(`
  Use \`red-router providers\` for the full provider management interface:

    red-router providers available   — show provider catalog
    red-router providers list        — list configured connections
    red-router providers test <name> — test a provider connection
    red-router providers test-all    — test all active connections
    red-router providers validate    — validate local configuration
    red-router providers add <id>    — add an API-key connection
    red-router providers auth <id>   — start an existing OAuth flow
    red-router providers remove <id> — remove a connection (requires confirmation)
`);
    });
}
