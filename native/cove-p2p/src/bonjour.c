#include <dns_sd.h>
#include <errno.h>
#include <poll.h>
#include <stdint.h>
#include <string.h>
#include <time.h>

struct lookup {
  char *output;
  size_t capacity;
  size_t used;
  int done;
};

static void on_record(DNSServiceRef service, DNSServiceFlags flags, uint32_t interface,
                      DNSServiceErrorType error, const char *name, uint16_t type,
                      uint16_t class_, uint16_t length, const void *data, uint32_t ttl,
                      void *context) {
  struct lookup *lookup = context;
  if (error != kDNSServiceErr_NoError) { lookup->done = 1; return; }
  if (!(flags & kDNSServiceFlagsAdd) || type != kDNSServiceType_TXT) return;
  const unsigned char *txt = data;
  size_t offset = 0;
  while (offset < length) {
    const size_t size = txt[offset++];
    if (offset + size > length) break;
    if (size > 8 && memcmp(txt + offset, "dnsaddr=", 8) == 0 &&
        lookup->used + size - 8 + 1 < lookup->capacity) {
      memcpy(lookup->output + lookup->used, txt + offset + 8, size - 8);
      lookup->used += size - 8;
      lookup->output[lookup->used++] = '\n';
    }
    offset += size;
  }
  if (lookup->used && !(flags & kDNSServiceFlagsMoreComing)) lookup->done = 1;
}

static int64_t monotonic_ms(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

// Bonjour handles local network permission and multicast on behalf of the app.
size_t cove_lan_lookup(const char *peer, char *output, size_t capacity) {
  char name[kDNSServiceMaxDomainName];
  if (DNSServiceConstructFullName(name, peer, "_p2p._udp", "local.") != 0) return 0;
  struct lookup lookup = { .output = output, .capacity = capacity };
  DNSServiceRef service = NULL;
  if (DNSServiceQueryRecord(&service, 0, kDNSServiceInterfaceIndexAny, name,
          kDNSServiceType_TXT, kDNSServiceClass_IN, on_record, &lookup) != kDNSServiceErr_NoError)
    return 0;

  const int64_t deadline = monotonic_ms() + 8000;
  struct pollfd socket = { .fd = DNSServiceRefSockFD(service), .events = POLLIN };
  while (!lookup.done && socket.fd >= 0) {
    const int remaining = (int)(deadline - monotonic_ms());
    if (remaining <= 0) break;
    const int ready = poll(&socket, 1, remaining);
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0 || !(socket.revents & POLLIN) ||
        DNSServiceProcessResult(service) != kDNSServiceErr_NoError) break;
  }
  DNSServiceRefDeallocate(service);
  return lookup.used;
}
