#!/usr/bin/env python3
"""MCP server entry point for Beekeeper (stdio transport)."""
from beekeeper.mcp_server.server import mcp


def main():
    """Run the MCP server."""
    mcp.run()


if __name__ == "__main__":
    main()
