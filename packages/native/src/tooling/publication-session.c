#include <sys/attr.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>

/* Only container creation is allowed here. Never remove ancestors on failure. */
static int open_parent(const char *path, int create) {
  const int flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC;
  if (!create) return open(path, flags);
  size_t length = strlen(path);
  if (length == 0 || length >= PATH_MAX || path[0] != '/') {
    errno = EINVAL;
    return -1;
  }
  char components[PATH_MAX];
  memcpy(components, path, length + 1);
  int parent = open("/", flags);
  if (parent < 0) return -1;
  char *component = components + 1;
  while (*component != '\0') {
    char *next = strchr(component, '/');
    if (next != NULL) *next = '\0';
    if (*component == '\0' || strcmp(component, ".") == 0 || strcmp(component, "..") == 0) {
      close(parent);
      errno = EINVAL;
      return -1;
    }
    int child = openat(parent, component, flags);
    if (child < 0 && errno == ENOENT) {
      if (mkdirat(parent, component, 0777) != 0 && errno != EEXIST) {
        int error = errno;
        close(parent);
        errno = error;
        return -1;
      }
      child = openat(parent, component, flags);
    }
    if (child < 0) {
      int error = errno;
      close(parent);
      errno = error;
      return -1;
    }
    close(parent);
    parent = child;
    if (next == NULL) break;
    component = next + 1;
  }
  return parent;
}

static int parent_matches(const char *path, const struct stat *identity) {
  int current = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC);
  if (current < 0) return 0;
  struct stat observed;
  int result = fstat(current, &observed);
  close(current);
  if (result != 0 || observed.st_dev != identity->st_dev || observed.st_ino != identity->st_ino) {
    errno = ESTALE;
    return 0;
  }
  return 1;
}

static int fail(const char *code) {
  int error = errno;
  printf("{\"schemaVersion\":1,\"kind\":\"error\",\"code\":\"%s\",\"errno\":%d}\n", code, error);
  fflush(stdout);
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 4 || strcmp(argv[1], "vgpu-publication-session/v1") != 0 ||
      (strcmp(argv[3], "create-parents") != 0 && strcmp(argv[3], "existing-parent") != 0)) {
    errno = EINVAL;
    return fail("helper-failed");
  }
  int parent = open_parent(argv[2], strcmp(argv[3], "create-parents") == 0);
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
  if (!parent_matches(argv[2], &identity)) return fail("parent-changed");
  printf("{\"schemaVersion\":1,\"kind\":\"ready\",\"parent\":{\"device\":\"%llu\",\"inode\":\"%llu\"},\"capabilities\":{\"renameSwap\":true,\"renameExclusive\":true}}\n",
    (unsigned long long)identity.st_dev, (unsigned long long)identity.st_ino);
  fflush(stdout);
  char command[16];
  while (fgets(command, sizeof(command), stdin) != NULL) {
    if (strcmp(command, "check\n") != 0) { errno = EINVAL; return fail("helper-failed"); }
    if (!parent_matches(argv[2], &identity)) {
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
