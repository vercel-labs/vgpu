#include <CommonCrypto/CommonDigest.h>
#include <sys/attr.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define JOURNAL_NAME ".vgpu-native-publication.json"
#define UPDATE_NAME ".vgpu-native-publication.update.json"
#define STAGE_NAME ".vgpu-native-stage"
#define JOURNAL_LIMIT (64U * 1024U)
#define RECORD_LIMIT (64U * 1024U)
#define CHUNK_LIMIT (64U * 1024U)
#define AGGREGATE_LIMIT (128ULL * 1024ULL * 1024ULL)

static const char *roles[4] = {
  "package-manifest", "swift-source", "metal-library", "output-record"
};

struct artifact {
  unsigned long long length;
  char hash[65];
  dev_t device;
  ino_t inode;
};

static int fail(const char *code) {
  int error = errno;
  printf("{\"schemaVersion\":1,\"kind\":\"error\",\"code\":\"%s\",\"errno\":%d}\n",
         code, error);
  fflush(stdout);
  return 1;
}

/* Only container creation is allowed here. Never remove ancestors on failure. */
static int open_parent(const char *path) {
  const int flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC;
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

static int valid_component(const char *value, long name_max) {
  size_t length = strlen(value);
  if (length == 0 || length > (size_t)name_max || strcmp(value, ".") == 0 ||
      strcmp(value, "..") == 0) return 0;
  for (size_t index = 0; index < length; index++) {
    unsigned char byte = (unsigned char)value[index];
    if (byte == '/' || byte < 0x20 || byte == 0x7f) return 0;
  }
  return 1;
}

static int valid_transaction(const char *value) {
  if (strlen(value) != 32) return 0;
  for (size_t index = 0; index < 32; index++)
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f'))) return 0;
  return 1;
}

static int ensure_absent(int directory, const char *name) {
  struct stat ignored;
  if (fstatat(directory, name, &ignored, AT_SYMLINK_NOFOLLOW) == 0) {
    errno = EEXIST;
    return -1;
  }
  return errno == ENOENT ? 0 : -1;
}

static int same_identity(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

static int write_all(int descriptor, const unsigned char *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = write(descriptor, bytes + offset, length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return -1;
    offset += (size_t)count;
  }
  return 0;
}

static int install_initial_journal(int parent, const char *bytes, size_t length,
                                   struct stat *identity) {
  int descriptor = openat(parent, JOURNAL_NAME,
                          O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (descriptor < 0) return -1;
  int result = write_all(descriptor, (const unsigned char *)bytes, length);
  if (result == 0) result = fstat(descriptor, identity);
  int close_result = close(descriptor);
  if (result == 0 && close_result != 0) result = -1;
  return result;
}

static int replace_owned_journal(int parent, const char *bytes, size_t length,
                                 struct stat *identity) {
  int descriptor = openat(parent, UPDATE_NAME,
                          O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (descriptor < 0) return -1;
  struct stat update_identity;
  int result = write_all(descriptor, (const unsigned char *)bytes, length);
  if (result == 0) result = fstat(descriptor, &update_identity);
  int close_result = close(descriptor);
  if (result == 0 && close_result != 0) result = -1;
  struct stat observed;
  if (result == 0) result = fstatat(parent, JOURNAL_NAME, &observed, AT_SYMLINK_NOFOLLOW);
  if (result == 0 && (!same_identity(identity, &observed) || !S_ISREG(observed.st_mode) ||
                      observed.st_nlink != 1)) {
    errno = ESTALE;
    result = -1;
  }
  if (result == 0) result = renameat(parent, UPDATE_NAME, parent, JOURNAL_NAME);
  if (result == 0) *identity = update_identity;
  if (result != 0) {
    int error = errno;
    unlinkat(parent, UPDATE_NAME, 0);
    errno = error;
  }
  return result;
}

static int append_json(char *buffer, size_t capacity, size_t *used,
                       const char *format, ...) {
  va_list arguments;
  va_start(arguments, format);
  int count = vsnprintf(buffer + *used, capacity - *used, format, arguments);
  va_end(arguments);
  if (count < 0 || (size_t)count >= capacity - *used) {
    errno = EOVERFLOW;
    return -1;
  }
  *used += (size_t)count;
  return 0;
}

static int append_json_string(char *buffer, size_t capacity, size_t *used,
                              const char *value) {
  if (append_json(buffer, capacity, used, "\"") != 0) return -1;
  for (const unsigned char *byte = (const unsigned char *)value; *byte != '\0'; byte++) {
    if (*byte == '"' || *byte == '\\') {
      if (append_json(buffer, capacity, used, "\\%c", *byte) != 0) return -1;
    } else if (*byte < 0x20) {
      if (append_json(buffer, capacity, used, "\\u%04x", *byte) != 0) return -1;
    } else if (append_json(buffer, capacity, used, "%c", *byte) != 0) {
      return -1;
    }
  }
  return append_json(buffer, capacity, used, "\"");
}

static int build_journal(char *buffer, size_t capacity, const char *phase,
                         const char *transaction, const char *destination,
                         const char *module, const struct stat *parent_identity,
                         const struct stat *stage_identity,
                         const struct artifact files[4], size_t *length) {
  size_t used = 0;
  if (append_json(buffer, capacity, &used,
      "{\"schemaVersion\":1,\"kind\":\"vgpu-native-publication\",\"phase\":\"%s\","
      "\"transactionId\":\"%s\",\"parent\":{\"device\":\"%llu\",\"inode\":\"%llu\"},"
      "\"destinationName\":",
      phase, transaction, (unsigned long long)parent_identity->st_dev,
      (unsigned long long)parent_identity->st_ino) != 0 ||
      append_json_string(buffer, capacity, &used, destination) != 0 ||
      append_json(buffer, capacity, &used, ",\"moduleName\":") != 0 ||
      append_json_string(buffer, capacity, &used, module) != 0) return -1;
  if (stage_identity != NULL && append_json(buffer, capacity, &used,
      ",\"stage\":{\"name\":\"%s\",\"device\":\"%llu\",\"inode\":\"%llu\"}",
      STAGE_NAME, (unsigned long long)stage_identity->st_dev,
      (unsigned long long)stage_identity->st_ino) != 0) return -1;
  if (files != NULL) {
    const char *paths[4];
    char swift[PATH_MAX];
    char library[PATH_MAX];
    if (snprintf(swift, sizeof(swift), "Sources/%s/Shaders.generated.swift", module) >= (int)sizeof(swift) ||
        snprintf(library, sizeof(library), "Sources/%s/Resources/Shaders.metallib", module) >= (int)sizeof(library)) {
      errno = ENAMETOOLONG;
      return -1;
    }
    paths[0] = "Package.swift";
    paths[1] = swift;
    paths[2] = library;
    paths[3] = ".vgpu-native-output.json";
    if (append_json(buffer, capacity, &used, ",\"recordSHA256\":\"%s\",\"files\":[", files[3].hash) != 0)
      return -1;
    for (int index = 0; index < 4; index++) {
      if (append_json(buffer, capacity, &used,
          "%s{\"role\":\"%s\",\"path\":\"%s\",\"length\":%llu,\"sha256\":\"%s\"}",
          index == 0 ? "" : ",", roles[index], paths[index], files[index].length,
          files[index].hash) != 0) return -1;
    }
    if (append_json(buffer, capacity, &used, "]") != 0) return -1;
  }
  if (append_json(buffer, capacity, &used, "}\n") != 0) return -1;
  *length = used;
  return 0;
}

static int open_child_directory(int parent, const char *name) {
  return openat(parent, name,
                O_RDONLY | O_NONBLOCK | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC);
}

static int make_child_directory(int parent, const char *name, struct stat *identity) {
  if (mkdirat(parent, name, 0700) != 0) return -1;
  int child = open_child_directory(parent, name);
  if (child < 0) return -1;
  if (fstat(child, identity) != 0) {
    int error = errno;
    close(child);
    errno = error;
    return -1;
  }
  return child;
}

static int receive_file(FILE *input, int directory, const char *name,
                        int expected_role, struct artifact *artifact,
                        unsigned long long *aggregate) {
  char header[1024];
  if (fgets(header, sizeof(header), input) == NULL) {
    errno = EPROTO;
    return -1;
  }
  int role = -1;
  unsigned long long length = 0;
  char hash[65] = {0};
  char trailer = '\0';
  if (sscanf(header, "file %d %llu %64[a-f0-9]%c", &role, &length, hash, &trailer) != 4 ||
      role != expected_role || trailer != '\n' || strlen(hash) != 64 ||
      length == 0 || (expected_role == 3 && length > RECORD_LIMIT) ||
      length > AGGREGATE_LIMIT || *aggregate > AGGREGATE_LIMIT - length) {
    errno = EPROTO;
    return -1;
  }
  int output = openat(directory, name,
                      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (output < 0) return -1;
  unsigned char chunk[CHUNK_LIMIT];
  unsigned long long remaining = length;
  int result = 0;
  while (remaining > 0) {
    size_t requested = remaining < sizeof(chunk) ? (size_t)remaining : sizeof(chunk);
    size_t count = fread(chunk, 1, requested, input);
    if (count != requested || write_all(output, chunk, count) != 0) {
      errno = EPROTO;
      result = -1;
      break;
    }
    remaining -= count;
  }
  struct stat identity;
  if (result == 0) result = fstat(output, &identity);
  if (result == 0 && (!S_ISREG(identity.st_mode) || identity.st_nlink != 1 ||
                      (unsigned long long)identity.st_size != length)) {
    errno = EINVAL;
    result = -1;
  }
  int close_result = close(output);
  if (result == 0 && close_result != 0) result = -1;
  if (result == 0) {
    artifact->length = length;
    memcpy(artifact->hash, hash, sizeof(artifact->hash));
    artifact->device = identity.st_dev;
    artifact->inode = identity.st_ino;
    *aggregate += length;
  }
  return result;
}

static int hash_file(int directory, const char *name, const struct artifact *artifact) {
  int descriptor = openat(directory, name,
                          O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) return -1;
  struct stat identity;
  int result = fstat(descriptor, &identity);
  if (result == 0 && (!S_ISREG(identity.st_mode) || identity.st_nlink != 1 ||
                      (unsigned long long)identity.st_size != artifact->length ||
                      identity.st_dev != artifact->device || identity.st_ino != artifact->inode)) {
    errno = EINVAL;
    result = -1;
  }
  CC_SHA256_CTX context;
  if (result == 0 && CC_SHA256_Init(&context) != 1) result = -1;
  unsigned char chunk[CHUNK_LIMIT];
  while (result == 0) {
    ssize_t count = read(descriptor, chunk, sizeof(chunk));
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) { result = -1; break; }
    if (count == 0) break;
    if (CC_SHA256_Update(&context, chunk, (CC_LONG)count) != 1) { result = -1; break; }
  }
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  if (result == 0 && CC_SHA256_Final(digest, &context) != 1) result = -1;
  close(descriptor);
  if (result != 0) return -1;
  char actual[65];
  for (size_t index = 0; index < sizeof(digest); index++)
    snprintf(actual + index * 2, 3, "%02x", digest[index]);
  if (strcmp(actual, artifact->hash) != 0) {
    errno = EBADMSG;
    return -1;
  }
  return 0;
}

static int exact_directory(int descriptor, const char *const *expected, size_t count) {
  int independent = openat(descriptor, ".",
                           O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC);
  if (independent < 0) return -1;
  DIR *directory = fdopendir(independent);
  if (directory == NULL) { close(independent); return -1; }
  size_t observed = 0;
  errno = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    int found = 0;
    for (size_t index = 0; index < count; index++)
      if (strcmp(entry->d_name, expected[index]) == 0) found = 1;
    if (!found) { errno = ENOTEMPTY; closedir(directory); return -1; }
    observed++;
  }
  int read_error = errno;
  closedir(directory);
  if (read_error != 0) { errno = read_error; return -1; }
  if (observed != count) { errno = ENOENT; return -1; }
  return 0;
}

static int directory_edge(int parent, const char *name, int retained,
                          const struct stat *expected) {
  struct stat retained_identity;
  struct stat named_identity;
  if (fstat(retained, &retained_identity) != 0 ||
      fstatat(parent, name, &named_identity, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISDIR(retained_identity.st_mode) || !S_ISDIR(named_identity.st_mode) ||
      !same_identity(&retained_identity, expected) ||
      !same_identity(&named_identity, expected)) {
    errno = ESTALE;
    return -1;
  }
  return 0;
}

static int verify_tree(int parent, int stage, const struct stat *stage_identity,
                       int sources, const struct stat *sources_identity,
                       int module, const char *module_name,
                       const struct stat *module_identity, int resources,
                       const struct stat *resources_identity,
                       const struct artifact files[4]) {
  const char *root_entries[] = { ".vgpu-native-output.json", "Package.swift", "Sources" };
  const char *sources_entries[] = { module_name };
  const char *module_entries[] = { "Resources", "Shaders.generated.swift" };
  const char *resource_entries[] = { "Shaders.metallib" };
  if (directory_edge(parent, STAGE_NAME, stage, stage_identity) != 0 ||
      directory_edge(stage, "Sources", sources, sources_identity) != 0 ||
      directory_edge(sources, module_name, module, module_identity) != 0 ||
      directory_edge(module, "Resources", resources, resources_identity) != 0 ||
      exact_directory(stage, root_entries, 3) != 0 ||
      exact_directory(sources, sources_entries, 1) != 0 ||
      exact_directory(module, module_entries, 2) != 0 ||
      exact_directory(resources, resource_entries, 1) != 0) return -1;
  return hash_file(stage, "Package.swift", &files[0]) == 0 &&
         hash_file(module, "Shaders.generated.swift", &files[1]) == 0 &&
         hash_file(resources, "Shaders.metallib", &files[2]) == 0 &&
         hash_file(stage, ".vgpu-native-output.json", &files[3]) == 0 ? 0 : -1;
}

static int remove_artifact(int directory, const char *name,
                           const struct artifact *artifact) {
  if (hash_file(directory, name, artifact) != 0) return -1;
  return unlinkat(directory, name, 0);
}

static int remove_empty_directory(int parent, const char *name, int retained,
                                  const struct stat *identity) {
  if (directory_edge(parent, name, retained, identity) != 0 ||
      exact_directory(retained, NULL, 0) != 0) return -1;
  return unlinkat(parent, name, AT_REMOVEDIR);
}

static int verify_bytes(int parent, const char *name, const struct stat *expected_identity,
                        const char *expected, size_t length) {
  int descriptor = openat(parent, name,
                          O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) return -1;
  struct stat identity;
  int result = fstat(descriptor, &identity);
  if (result == 0 && (!same_identity(&identity, expected_identity) ||
                      !S_ISREG(identity.st_mode) || identity.st_nlink != 1 ||
                      (size_t)identity.st_size != length)) result = -1;
  char buffer[JOURNAL_LIMIT];
  size_t used = 0;
  while (result == 0 && used < length) {
    ssize_t count = read(descriptor, buffer + used, length - used);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { result = -1; break; }
    used += (size_t)count;
  }
  close(descriptor);
  if (result == 0 && memcmp(buffer, expected, length) != 0) result = -1;
  if (result != 0) errno = ESTALE;
  return result;
}

int main(int argc, char **argv) {
  if (argc != 6 || strcmp(argv[1], "vgpu-publication-staging/v1") != 0 ||
      !valid_transaction(argv[5])) {
    errno = EINVAL;
    return fail("helper-failed");
  }
  const char *parent_path = argv[2];
  const char *destination = argv[3];
  const char *module = argv[4];
  const char *transaction = argv[5];
  int parent = open_parent(parent_path);
  if (parent < 0) return fail("unsafe-parent");
  struct stat parent_identity;
  if (fstat(parent, &parent_identity) != 0) return fail("unsafe-parent");
  if (flock(parent, LOCK_EX | LOCK_NB) != 0)
    return fail(errno == EWOULDBLOCK ? "busy" : "helper-failed");
  long name_max = fpathconf(parent, _PC_NAME_MAX);
  if (name_max <= 0 || !valid_component(destination, name_max) ||
      !valid_component(module, name_max) || strcmp(destination, JOURNAL_NAME) == 0 ||
      strcmp(destination, UPDATE_NAME) == 0 || strcmp(destination, STAGE_NAME) == 0) {
    errno = EINVAL;
    return fail("unsafe-name");
  }
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
  if (!parent_matches(parent_path, &parent_identity)) return fail("parent-changed");
  if (ensure_absent(parent, destination) != 0 || ensure_absent(parent, JOURNAL_NAME) != 0 ||
      ensure_absent(parent, UPDATE_NAME) != 0 || ensure_absent(parent, STAGE_NAME) != 0)
    return fail("conflict");

  char journal[JOURNAL_LIMIT];
  size_t journal_length = 0;
  struct stat journal_identity;
  if (build_journal(journal, sizeof(journal), "intent", transaction, destination,
                    module, &parent_identity, NULL, NULL, &journal_length) != 0 ||
      install_initial_journal(parent, journal, journal_length, &journal_identity) != 0)
    return fail("helper-failed");

  struct stat stage_identity;
  int stage = make_child_directory(parent, STAGE_NAME, &stage_identity);
  if (stage < 0) return fail("helper-failed");
  if (build_journal(journal, sizeof(journal), "staging", transaction, destination,
                    module, &parent_identity, &stage_identity, NULL, &journal_length) != 0 ||
      replace_owned_journal(parent, journal, journal_length, &journal_identity) != 0)
    return fail("helper-failed");

  struct stat sources_identity;
  struct stat module_identity;
  struct stat resources_identity;
  int sources = make_child_directory(stage, "Sources", &sources_identity);
  int module_directory = sources < 0 ? -1 :
    make_child_directory(sources, module, &module_identity);
  int resources = module_directory < 0 ? -1 :
    make_child_directory(module_directory, "Resources", &resources_identity);
  if (resources < 0) return fail("helper-failed");
  printf("{\"schemaVersion\":1,\"kind\":\"ready\"}\n");
  fflush(stdout);

  struct artifact files[4] = {0};
  unsigned long long aggregate = 0;
  if (receive_file(stdin, stage, "Package.swift", 0, &files[0], &aggregate) != 0 ||
      receive_file(stdin, module_directory, "Shaders.generated.swift", 1, &files[1], &aggregate) != 0 ||
      receive_file(stdin, resources, "Shaders.metallib", 2, &files[2], &aggregate) != 0 ||
      receive_file(stdin, stage, ".vgpu-native-output.json", 3, &files[3], &aggregate) != 0)
    return fail("invalid-transfer");
  char command[64];
  if (fgets(command, sizeof(command), stdin) == NULL || strcmp(command, "prepare\n") != 0)
    return fail("invalid-transfer");
  if (!parent_matches(parent_path, &parent_identity)) return fail("parent-changed");
  if (verify_tree(parent, stage, &stage_identity, sources, &sources_identity,
                  module_directory, module, &module_identity, resources,
                  &resources_identity, files) != 0)
    return fail("invalid-stage");
  if (build_journal(journal, sizeof(journal), "prepared", transaction, destination,
                    module, &parent_identity, &stage_identity, files, &journal_length) != 0 ||
      journal_length > JOURNAL_LIMIT ||
      replace_owned_journal(parent, journal, journal_length, &journal_identity) != 0)
    return fail("helper-failed");

  char receipt[JOURNAL_LIMIT];
  size_t receipt_length = 0;
  if (build_journal(receipt, sizeof(receipt), "prepared", transaction, destination,
                    module, &parent_identity, &stage_identity, files, &receipt_length) != 0)
    return fail("helper-failed");
  char *kind = strstr(receipt, "\"kind\":\"vgpu-native-publication\",\"phase\":\"prepared\"");
  if (kind == NULL) return fail("helper-failed");
  const char replacement[] = "\"kind\":\"prepared\"";
  size_t old_length = strlen("\"kind\":\"vgpu-native-publication\",\"phase\":\"prepared\"");
  size_t new_length = strlen(replacement);
  memmove(kind + new_length, kind + old_length,
          receipt_length - (size_t)(kind - receipt) - old_length + 1);
  memcpy(kind, replacement, new_length);
  receipt_length -= old_length - new_length;
  fwrite(receipt, 1, receipt_length, stdout);
  fflush(stdout);

  if (fgets(command, sizeof(command), stdin) == NULL || strcmp(command, "finalize\n") != 0)
    return fail("helper-failed");
  if (!parent_matches(parent_path, &parent_identity)) return fail("cleanup-failed");
  if (verify_tree(parent, stage, &stage_identity, sources, &sources_identity,
                  module_directory, module, &module_identity, resources,
                  &resources_identity, files) != 0)
    return fail("cleanup-failed");
  if (verify_bytes(parent, JOURNAL_NAME, &journal_identity, journal, journal_length) != 0)
    return fail("cleanup-failed");
  if (remove_artifact(stage, "Package.swift", &files[0]) != 0)
    return fail("cleanup-failed");
  if (remove_artifact(module_directory, "Shaders.generated.swift", &files[1]) != 0)
    return fail("cleanup-failed");
  if (remove_artifact(resources, "Shaders.metallib", &files[2]) != 0)
    return fail("cleanup-failed");
  if (remove_artifact(stage, ".vgpu-native-output.json", &files[3]) != 0)
    return fail("cleanup-failed");
  if (remove_empty_directory(module_directory, "Resources", resources,
                             &resources_identity) != 0)
    return fail("cleanup-failed");
  if (remove_empty_directory(sources, module, module_directory,
                             &module_identity) != 0)
    return fail("cleanup-failed");
  if (remove_empty_directory(stage, "Sources", sources, &sources_identity) != 0)
    return fail("cleanup-failed");
  if (remove_empty_directory(parent, STAGE_NAME, stage, &stage_identity) != 0)
    return fail("cleanup-failed");
  if (verify_bytes(parent, JOURNAL_NAME, &journal_identity, journal, journal_length) != 0 ||
      unlinkat(parent, JOURNAL_NAME, 0) != 0)
    return fail("cleanup-failed");
  puts("{\"schemaVersion\":1,\"kind\":\"finalized\"}");
  fflush(stdout);
  close(resources);
  close(module_directory);
  close(sources);
  close(stage);
  close(parent);
  return 0;
}
