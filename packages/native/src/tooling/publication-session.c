#include <sys/attr.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>

static int fail(const char *code) {
  int error = errno;
  printf("{\"schemaVersion\":1,\"kind\":\"error\",\"code\":\"%s\",\"errno\":%d}\n", code, error);
  fflush(stdout);
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 3 || strcmp(argv[1], "vgpu-publication-session/v1") != 0) {
    errno = EINVAL;
    return fail("helper-failed");
  }
  int parent = open(argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC);
  if (parent < 0) return fail("unsafe-parent");
  struct stat identity;
  if (fstat(parent, &identity) != 0) return fail("unsafe-parent");
  if (flock(parent, LOCK_EX | LOCK_NB) != 0)
    return fail(errno == EWOULDBLOCK ? "busy" : "helper-failed");

  struct attrlist attributes = { .bitmapcount = ATTR_BIT_MAP_COUNT, .volattr = ATTR_VOL_CAPABILITIES };
  struct { uint32_t length; vol_capabilities_attr_t value; } capabilities = {0};
  if (fgetattrlist(parent, &attributes, &capabilities, sizeof(capabilities), 0) != 0)
    return fail("unsupported-filesystem");
  unsigned int required = VOL_CAP_INT_RENAME_SWAP | VOL_CAP_INT_RENAME_EXCL;
  unsigned int valid = capabilities.value.valid[VOL_CAPABILITIES_INTERFACES];
  unsigned int supported = capabilities.value.capabilities[VOL_CAPABILITIES_INTERFACES];
  if ((valid & required) != required || (supported & required) != required) {
    errno = ENOTSUP;
    return fail("unsupported-filesystem");
  }
  printf("{\"schemaVersion\":1,\"kind\":\"ready\",\"parent\":{\"device\":\"%llu\",\"inode\":\"%llu\"},\"capabilities\":{\"renameSwap\":true,\"renameExclusive\":true}}\n",
    (unsigned long long)identity.st_dev, (unsigned long long)identity.st_ino);
  fflush(stdout);
  char command[16];
  while (fgets(command, sizeof(command), stdin) != NULL) {
    if (strcmp(command, "check\n") != 0) { errno = EINVAL; return fail("helper-failed"); }
    int current = open(argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC);
    if (current < 0) { fail("parent-changed"); continue; }
    struct stat observed;
    int result = fstat(current, &observed);
    close(current);
    if (result != 0 || observed.st_dev != identity.st_dev || observed.st_ino != identity.st_ino) {
      errno = ESTALE;
      fail("parent-changed");
      continue;
    }
    puts("{\"schemaVersion\":1,\"kind\":\"checked\"}");
    fflush(stdout);
  }
  if (ferror(stdin)) return fail("helper-failed");
  close(parent);
  return 0;
}
