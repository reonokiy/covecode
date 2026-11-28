#pragma once
#include <stdbool.h>
bool cove_tunnel_update(const char *url, const char *endpoint);
char *cove_tunnel_open(const char *endpoint);
void cove_tunnel_close(const char *url);
void cove_tunnel_free(char *url);
