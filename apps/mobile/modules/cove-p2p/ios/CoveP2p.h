#pragma once
char *cove_tunnel_open(const char *endpoint);
void cove_tunnel_close(const char *url);
void cove_tunnel_free(char *url);
