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
#define RECOVERY_CHUNK_LIMIT (16U * 1024U)
#define TRANSFER_SHORT (-2)

static const char *roles[4] = {
  "package-manifest", "swift-source", "metal-library", "output-record"
};

struct artifact {
  unsigned long long length;
  char hash[65];
  dev_t device;
  ino_t inode;
  int created;
  unsigned long long written_length;
  char written_hash[65];
};

static int fail(const char *code) {
  int error = errno;
  printf("{\"schemaVersion\":1,\"kind\":\"error\",\"code\":\"%s\",\"errno\":%d}\n",
         code, error);
  fflush(stdout);
  return 1;
}

static int fail_journal_update(int retained_update) {
  if (!retained_update) return fail("helper-failed");
  int error = errno;
  printf("{\"schemaVersion\":1,\"kind\":\"error\",\"code\":\"helper-failed\","
         "\"errno\":%d,\"retainedUpdate\":true}\n", error);
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

static int parse_decimal(const char *value, unsigned long long *result) {
  size_t length = strlen(value);
  if (length == 0 || length > 20 || (length > 1 && value[0] == '0')) return -1;
  unsigned long long number = 0;
  for (size_t index = 0; index < length; index++) {
    if (value[index] < '0' || value[index] > '9') return -1;
    unsigned int digit = (unsigned int)(value[index] - '0');
    if (number > (ULLONG_MAX - digit) / 10) return -1;
    number = number * 10 + digit;
  }
  *result = number;
  return 0;
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

static int verify_bytes(int parent, const char *name, const struct stat *expected_identity,
                        const char *expected, size_t length);

static int replace_owned_journal(int parent, const char *bytes, size_t length,
                                 struct stat *identity, const char *previous,
                                 size_t previous_length, int *retained_update) {
  *retained_update = 0;
  if (verify_bytes(parent, JOURNAL_NAME, identity, previous, previous_length) != 0)
    return -1;
  int descriptor = openat(parent, UPDATE_NAME,
                          O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (descriptor < 0) return -1;
  *retained_update = 1;
  struct stat update_identity;
  int result = write_all(descriptor, (const unsigned char *)bytes, length);
  if (result == 0) result = fstat(descriptor, &update_identity);
  int error = result != 0 ? errno : 0;
  int close_result = close(descriptor);
  if (result == 0 && close_result != 0) {
    result = -1;
    error = errno;
  }
  /* An incomplete update has no verified actual-byte ledger. Preserve it on failure. */
  if (result != 0) {
    errno = error;
    return -1;
  }
  if (verify_bytes(parent, UPDATE_NAME, &update_identity, bytes, length) != 0 ||
      verify_bytes(parent, JOURNAL_NAME, identity, previous, previous_length) != 0 ||
      renameat(parent, UPDATE_NAME, parent, JOURNAL_NAME) != 0)
    return -1;
  *identity = update_identity;
  *retained_update = 0;
  return 0;
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
                         const char *module, int publishing,
                         const struct stat *old_destination_identity,
                         const struct stat *parent_identity,
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
  if (publishing) {
    if (old_destination_identity != NULL) {
      if (append_json(buffer, capacity, &used,
          ",\"publication\":{\"renameMode\":\"replace-empty\",\"expectedDestination\":\"empty\","
          "\"oldDestination\":{\"device\":\"%llu\",\"inode\":\"%llu\"}}",
          (unsigned long long)old_destination_identity->st_dev,
          (unsigned long long)old_destination_identity->st_ino) != 0)
        return -1;
    } else if (append_json(buffer, capacity, &used,
        ",\"publication\":{\"renameMode\":\"excl\",\"expectedDestination\":\"missing\"}") != 0)
      return -1;
  }
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

static int build_commit_receipt(char *buffer, size_t capacity, const char *transaction,
                                const char *destination, const struct stat *parent_identity,
                                const struct stat *output_identity, const char *record_hash,
                                size_t *length) {
  size_t used = 0;
  if (append_json(buffer, capacity, &used,
      "{\"schemaVersion\":1,\"kind\":\"commit-result\",\"transactionId\":\"%s\","
      "\"phase\":\"prepared\",\"outcome\":\"published\","
      "\"parent\":{\"device\":\"%llu\",\"inode\":\"%llu\"},\"destinationName\":",
      transaction, (unsigned long long)parent_identity->st_dev,
      (unsigned long long)parent_identity->st_ino) != 0 ||
      append_json_string(buffer, capacity, &used, destination) != 0 ||
      append_json(buffer, capacity, &used,
      ",\"output\":{\"device\":\"%llu\",\"inode\":\"%llu\"},\"recordSHA256\":\"%s\"}\n",
      (unsigned long long)output_identity->st_dev,
      (unsigned long long)output_identity->st_ino, record_hash) != 0)
    return -1;
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
  CC_SHA256_CTX written_context;
  if (CC_SHA256_Init(&written_context) != 1) return -1;
  int output = openat(directory, name,
                      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (output < 0) return -1;
  struct stat identity;
  if (fstat(output, &identity) != 0 || !S_ISREG(identity.st_mode) ||
      identity.st_nlink != 1 || identity.st_size != 0) {
    int error = errno;
    close(output);
    errno = error == 0 ? EINVAL : error;
    return -1;
  }
  artifact->created = 1;
  artifact->device = identity.st_dev;
  artifact->inode = identity.st_ino;
  artifact->length = length;
  memcpy(artifact->hash, hash, sizeof(artifact->hash));
  unsigned char chunk[CHUNK_LIMIT];
  unsigned long long remaining = length;
  int result = 0;
  while (remaining > 0) {
    size_t requested = remaining < sizeof(chunk) ? (size_t)remaining : sizeof(chunk);
    size_t count = fread(chunk, 1, requested, input);
    size_t written = 0;
    while (written < count) {
      ssize_t added = write(output, chunk + written, count - written);
      if (added < 0 && errno == EINTR) continue;
      if (added <= 0) { result = -1; break; }
      artifact->written_length += (size_t)added;
      if (CC_SHA256_Update(&written_context, chunk + written, (CC_LONG)added) != 1) {
        errno = EIO;
        result = -1;
        break;
      }
      written += (size_t)added;
    }
    if (result != 0) break;
    remaining -= count;
    if (count != requested) {
      errno = EPROTO;
      result = feof(input) && !ferror(input) ? TRANSFER_SHORT : -1;
      break;
    }
  }
  if (result == 0) result = fstat(output, &identity);
  if (result == 0 && (!S_ISREG(identity.st_mode) || identity.st_nlink != 1 ||
                      (unsigned long long)identity.st_size != length)) {
    errno = EINVAL;
    result = -1;
  }
  if (result == 0 || result == TRANSFER_SHORT) {
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    if (CC_SHA256_Final(digest, &written_context) != 1) result = -1;
    else for (size_t index = 0; index < sizeof(digest); index++)
      snprintf(artifact->written_hash + index * 2, 3, "%02x", digest[index]);
  }
  int close_result = close(output);
  if (close_result != 0) result = -1;
  if (result == 0) *aggregate += length;
  if (result == TRANSFER_SHORT) errno = EPROTO;
  return result;
}

struct recovery_observation {
  int present;
  struct stat identity;
};

struct reconciliation_request {
  const char *destination;
  const char *module;
  const char *transaction;
  int empty_destination;
};

static int verify_recovery(int parent, const char *parent_path,
                                     const struct stat *parent_identity,
                                     const struct stat *journal_identity,
                                     const char *journal, size_t journal_length,
                                     const struct recovery_observation *stage,
                                     const struct recovery_observation *update,
                                     const struct recovery_observation *destination,
                                     const struct reconciliation_request *request);

static int observe_recovery_name(int parent, const char *name,
                                 struct recovery_observation *observation) {
  if (fstatat(parent, name, &observation->identity, AT_SYMLINK_NOFOLLOW) == 0) {
    observation->present = 1;
    return 0;
  }
  if (errno != ENOENT) return -1;
  observation->present = 0;
  return 0;
}

static int recovery_name_matches(int parent, const char *name,
                                  const struct recovery_observation *expected) {
  struct recovery_observation observed = {0};
  if (observe_recovery_name(parent, name, &observed) != 0) return -1;
  if (observed.present != expected->present ||
      (observed.present &&
       (!same_identity(&observed.identity, &expected->identity) ||
        (observed.identity.st_mode & S_IFMT) != (expected->identity.st_mode & S_IFMT)))) {
    errno = ESTALE;
    return -1;
  }
  return 0;
}

static void print_recovery_observation(const struct recovery_observation *observation) {
  if (!observation->present) {
    fputs("null", stdout);
    return;
  }
  const struct stat *identity = &observation->identity;
  const char *kind = S_ISDIR(identity->st_mode) ? "directory" :
    S_ISREG(identity->st_mode) ? "file" : S_ISLNK(identity->st_mode) ? "symlink" : "other";
  printf("{\"device\":\"%llu\",\"inode\":\"%llu\",\"kind\":\"%s\"}",
         (unsigned long long)identity->st_dev, (unsigned long long)identity->st_ino, kind);
}

/* Read-only startup report: names are fixed here; journal semantics belong to the caller. */
static int report_recovery(int parent, const char *parent_path,
                           const struct stat *parent_identity,
                           const struct stat *named_journal, long name_max,
                           const struct reconciliation_request *reconciliation) {
  /* Even a nonblocking FIFO open can release another process waiting for a reader. */
  if (!S_ISREG(named_journal->st_mode) || named_journal->st_nlink != 1 ||
      named_journal->st_size <= 0 || named_journal->st_size > JOURNAL_LIMIT) {
    errno = EINVAL;
    return fail("conflict");
  }
  int descriptor = openat(parent, JOURNAL_NAME,
                          O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) return fail("conflict");
  struct stat identity;
  int result = fstat(descriptor, &identity);
  if (result == 0 && (!same_identity(&identity, named_journal) ||
                      !S_ISREG(identity.st_mode) || identity.st_nlink != 1 ||
                      identity.st_size <= 0 || identity.st_size > JOURNAL_LIMIT)) {
    errno = EINVAL;
    result = -1;
  }
  unsigned char bytes[JOURNAL_LIMIT + 1];
  size_t length = 0;
  while (result == 0 && length < sizeof(bytes)) {
    ssize_t count = read(descriptor, bytes + length, sizeof(bytes) - length);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) { result = -1; break; }
    if (count == 0) break;
    length += (size_t)count;
  }
  if (result == 0 && (length > JOURNAL_LIMIT || length != (size_t)identity.st_size)) {
    errno = ESTALE;
    result = -1;
  }
  int error = result != 0 ? errno : 0;
  if (close(descriptor) != 0 && result == 0) { result = -1; error = errno; }
  if (result != 0) { errno = error; return fail("conflict"); }
  struct recovery_observation stage = {0};
  struct recovery_observation update = {0};
  struct recovery_observation destination = {0};
  if (observe_recovery_name(parent, STAGE_NAME, &stage) != 0 ||
      observe_recovery_name(parent, UPDATE_NAME, &update) != 0 ||
      (reconciliation != NULL &&
       observe_recovery_name(parent, reconciliation->destination, &destination) != 0))
    return fail("conflict");
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  if (CC_SHA256(bytes, (CC_LONG)length, digest) == NULL) {
    errno = EIO;
    return fail("helper-failed");
  }
  char hash[65];
  for (size_t index = 0; index < sizeof(digest); index++)
    snprintf(hash + index * 2, 3, "%02x", digest[index]);
  const size_t chunk_count = (length + RECOVERY_CHUNK_LIMIT - 1) / RECOVERY_CHUNK_LIMIT;
  printf("{\"schemaVersion\":1,\"kind\":\"%s\","
         "\"parent\":{\"device\":\"%llu\",\"inode\":\"%llu\"},"
         "\"journal\":{\"device\":\"%llu\",\"inode\":\"%llu\"},"
         "\"nameMax\":%ld,\"length\":%zu,\"sha256\":\"%s\",\"chunkCount\":%zu,\"stage\":",
         reconciliation == NULL ? "recovery" : "reconciliation",
         (unsigned long long)parent_identity->st_dev, (unsigned long long)parent_identity->st_ino,
         (unsigned long long)identity.st_dev, (unsigned long long)identity.st_ino,
         name_max, length, hash, chunk_count);
  print_recovery_observation(&stage);
  fputs(",\"update\":", stdout);
  print_recovery_observation(&update);
  if (reconciliation != NULL) {
    fputs(",\"destination\":", stdout);
    print_recovery_observation(&destination);
  }
  fputs("}\n", stdout);
  for (size_t index = 0; index < chunk_count; index++) {
    const size_t offset = index * RECOVERY_CHUNK_LIMIT;
    const size_t count = length - offset < RECOVERY_CHUNK_LIMIT ?
      length - offset : RECOVERY_CHUNK_LIMIT;
    char hex[RECOVERY_CHUNK_LIMIT * 2 + 1];
    static const char digits[] = "0123456789abcdef";
    for (size_t byte = 0; byte < count; byte++) {
      hex[byte * 2] = digits[bytes[offset + byte] >> 4];
      hex[byte * 2 + 1] = digits[bytes[offset + byte] & 15];
    }
    hex[count * 2] = '\0';
    printf("{\"schemaVersion\":1,\"kind\":\"recovery-chunk\",\"index\":%zu,\"hex\":\"%s\"}\n",
           index, hex);
    if (fflush(stdout) != 0) return 1;
  }
  if (!parent_matches(parent_path, parent_identity) ||
      verify_bytes(parent, JOURNAL_NAME, &identity, (const char *)bytes, length) != 0 ||
      recovery_name_matches(parent, STAGE_NAME, &stage) != 0 ||
      recovery_name_matches(parent, UPDATE_NAME, &update) != 0 ||
      (reconciliation != NULL &&
       recovery_name_matches(parent, reconciliation->destination, &destination) != 0))
    return fail("conflict");
  fputs("{\"schemaVersion\":1,\"kind\":\"recovery-complete\"}\n", stdout);
  if (fflush(stdout) != 0) return 1;
  if (reconciliation != NULL &&
      verify_recovery(parent, parent_path, parent_identity, &identity,
                                (const char *)bytes, length, &stage, &update,
                                &destination, reconciliation) != 0)
    return 1;
  /* Keep the parent lock until the report consumer closes input; never interpret commands. */
  while (fread(bytes, 1, sizeof(bytes), stdin) > 0) {}
  if (ferror(stdin)) return 1;
  close(parent);
  return 0;
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

static int verify_tree(int parent, const char *root_name, int stage,
                       const struct stat *stage_identity,
                       int sources, const struct stat *sources_identity,
                       int module, const char *module_name,
                       const struct stat *module_identity, int resources,
                       const struct stat *resources_identity,
                       const struct artifact files[4]) {
  const char *root_entries[] = { ".vgpu-native-output.json", "Package.swift", "Sources" };
  const char *sources_entries[] = { module_name };
  const char *module_entries[] = { "Resources", "Shaders.generated.swift" };
  const char *resource_entries[] = { "Shaders.metallib" };
  if (directory_edge(parent, root_name, stage, stage_identity) != 0 ||
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

static int read_reconciliation_line(char *line, size_t capacity) {
  size_t used = 0;
  while (used + 1 < capacity) {
    int byte = fgetc(stdin);
    if (byte == EOF || byte == '\0') break;
    line[used++] = (char)byte;
    if (byte == '\n') {
      line[used] = '\0';
      return 0;
    }
  }
  errno = EPROTO;
  return -1;
}

/* The caller has joined this locked journal to its original prepared receipt. */
static int verify_recovery(int parent, const char *parent_path,
                                     const struct stat *parent_identity,
                                     const struct stat *journal_identity,
                                     const char *journal, size_t journal_length,
                                     const struct recovery_observation *stage,
                                     const struct recovery_observation *update,
                                     const struct recovery_observation *destination,
                                     const struct reconciliation_request *request) {
  char line[256];
  char canonical[256];
  char transaction[33] = {0};
  char device[21] = {0};
  char inode[21] = {0};
  char old_device[21] = {0};
  char old_inode[21] = {0};
  char trailer = '\0';
  unsigned long long expected_device = 0;
  unsigned long long expected_inode = 0;
  unsigned long long expected_old_device = 0;
  unsigned long long expected_old_inode = 0;
  if (read_reconciliation_line(line, sizeof(line)) != 0)
    return fail("invalid-transfer");
  int fields = request->empty_destination ?
    sscanf(line, "verify-empty %32[a-f0-9] prepared %20[0-9] %20[0-9] %20[0-9] %20[0-9]%c",
           transaction, device, inode, old_device, old_inode, &trailer) :
    sscanf(line, "verify-missing %32[a-f0-9] prepared %20[0-9] %20[0-9]%c",
           transaction, device, inode, &trailer);
  if (fields != (request->empty_destination ? 6 : 4) || trailer != '\n' ||
      strcmp(transaction, request->transaction) != 0 ||
      parse_decimal(device, &expected_device) != 0 ||
      parse_decimal(inode, &expected_inode) != 0 ||
      (request->empty_destination &&
       (parse_decimal(old_device, &expected_old_device) != 0 ||
        parse_decimal(old_inode, &expected_old_inode) != 0 ||
        expected_device != (unsigned long long)parent_identity->st_dev ||
        expected_old_device != (unsigned long long)parent_identity->st_dev ||
        expected_inode == expected_old_inode ||
        expected_inode == (unsigned long long)parent_identity->st_ino ||
        expected_old_inode == (unsigned long long)parent_identity->st_ino))) {
    errno = EPROTO;
    return fail("invalid-transfer");
  }
  if (request->empty_destination)
    snprintf(canonical, sizeof(canonical), "verify-empty %s prepared %llu %llu %llu %llu\n",
             request->transaction, expected_device, expected_inode,
             expected_old_device, expected_old_inode);
  else
    snprintf(canonical, sizeof(canonical), "verify-missing %s prepared %llu %llu\n",
             request->transaction, expected_device, expected_inode);
  if (strcmp(line, canonical) != 0) {
    errno = EPROTO;
    return fail("invalid-transfer");
  }
  struct artifact files[4] = {0};
  unsigned long long aggregate = 0;
  for (int index = 0; index < 4; index++) {
    char role[2] = {0};
    char length[21] = {0};
    if (read_reconciliation_line(line, sizeof(line)) != 0 ||
        sscanf(line, "artifact %1[0-3] %20[0-9] %64[a-f0-9]%c",
               role, length, files[index].hash, &trailer) != 4 ||
        role[0] != '0' + index || trailer != '\n' || strlen(files[index].hash) != 64 ||
        parse_decimal(length, &files[index].length) != 0 || files[index].length == 0 ||
        (index == 3 && files[index].length > RECORD_LIMIT) ||
        files[index].length > AGGREGATE_LIMIT || aggregate > AGGREGATE_LIMIT - files[index].length) {
      errno = EPROTO;
      return fail("invalid-transfer");
    }
    snprintf(canonical, sizeof(canonical), "artifact %d %llu %s\n",
             index, files[index].length, files[index].hash);
    if (strcmp(line, canonical) != 0) {
      errno = EPROTO;
      return fail("invalid-transfer");
    }
    aggregate += files[index].length;
  }
  int published = destination->present;
  int old_destination = -1;
  if (request->empty_destination) {
    /* Non-publication requires the original empty root, never absence or a replacement. */
    if (!destination->present || !S_ISDIR(destination->identity.st_mode)) {
      errno = ESTALE;
      return fail("conflict");
    }
    published = (unsigned long long)destination->identity.st_dev == expected_device &&
                (unsigned long long)destination->identity.st_ino == expected_inode;
    if (!published) {
      if ((unsigned long long)destination->identity.st_dev != expected_old_device ||
          (unsigned long long)destination->identity.st_ino != expected_old_inode) {
        errno = ESTALE;
        return fail("conflict");
      }
      old_destination = open_child_directory(parent, request->destination);
      if (old_destination < 0 ||
          directory_edge(parent, request->destination, old_destination,
                         &destination->identity) != 0 ||
          exact_directory(old_destination, NULL, 0) != 0)
        return fail("conflict");
    }
  }
  const struct recovery_observation *candidate = published ? destination : stage;
  const char *root_name = published ? request->destination : STAGE_NAME;
  if (!candidate->present || !S_ISDIR(candidate->identity.st_mode) ||
      (unsigned long long)candidate->identity.st_dev != expected_device ||
      (unsigned long long)candidate->identity.st_ino != expected_inode) {
    errno = ESTALE;
    return fail("conflict");
  }
  int root = open_child_directory(parent, root_name);
  if (root < 0) return fail("conflict");
  int sources = open_child_directory(root, "Sources");
  if (sources < 0) return fail("invalid-stage");
  int module = open_child_directory(sources, request->module);
  if (module < 0) return fail("invalid-stage");
  int resources = open_child_directory(module, "Resources");
  if (resources < 0) return fail("invalid-stage");
  struct stat sources_identity;
  struct stat module_identity;
  struct stat resources_identity;
  if (fstat(sources, &sources_identity) != 0 || fstat(module, &module_identity) != 0 ||
      fstat(resources, &resources_identity) != 0)
    return fail("invalid-stage");
  const int directories[] = { root, module, resources, root };
  const char *names[] = {
    "Package.swift", "Shaders.generated.swift", "Shaders.metallib", ".vgpu-native-output.json"
  };
  for (int index = 0; index < 4; index++) {
    struct stat identity;
    if (fstatat(directories[index], names[index], &identity, AT_SYMLINK_NOFOLLOW) != 0)
      return fail("invalid-stage");
    if (!S_ISREG(identity.st_mode) || identity.st_nlink != 1 ||
        (unsigned long long)identity.st_size != files[index].length) {
      errno = ESTALE;
      return fail("invalid-stage");
    }
    files[index].device = identity.st_dev;
    files[index].inode = identity.st_ino;
  }
  if (verify_tree(parent, root_name, root, &candidate->identity,
                  sources, &sources_identity, module, request->module, &module_identity,
                  resources, &resources_identity, files) != 0)
    return fail("invalid-stage");
  if (!parent_matches(parent_path, parent_identity) ||
      verify_bytes(parent, JOURNAL_NAME, journal_identity, journal, journal_length) != 0 ||
      recovery_name_matches(parent, STAGE_NAME, stage) != 0 ||
      recovery_name_matches(parent, UPDATE_NAME, update) != 0 ||
      recovery_name_matches(parent, request->destination, destination) != 0 ||
      directory_edge(parent, root_name, root, &candidate->identity) != 0 ||
      directory_edge(root, "Sources", sources, &sources_identity) != 0 ||
      directory_edge(sources, request->module, module, &module_identity) != 0 ||
      directory_edge(module, "Resources", resources, &resources_identity) != 0 ||
      (old_destination >= 0 &&
       (directory_edge(parent, request->destination, old_destination,
                       &destination->identity) != 0 ||
        exact_directory(old_destination, NULL, 0) != 0)))
    return fail("conflict");
  if (close(resources) != 0 || close(module) != 0 || close(sources) != 0 || close(root) != 0 ||
      (old_destination >= 0 && close(old_destination) != 0))
    return fail("helper-failed");
  char receipt[JOURNAL_LIMIT];
  size_t used = 0;
  if (append_json(receipt, sizeof(receipt), &used,
      "{\"schemaVersion\":1,\"kind\":\"reconciliation-result\",\"transactionId\":\"%s\","
      "\"phase\":\"prepared\",\"outcome\":\"%s\","
      "\"parent\":{\"device\":\"%llu\",\"inode\":\"%llu\"},\"destinationName\":",
      request->transaction, published ? "published" : "not-published",
      (unsigned long long)parent_identity->st_dev,
      (unsigned long long)parent_identity->st_ino) != 0 ||
      append_json_string(receipt, sizeof(receipt), &used, request->destination) != 0 ||
      append_json(receipt, sizeof(receipt), &used,
      ",\"%s\":{\"device\":\"%llu\",\"inode\":\"%llu\"},\"recordSHA256\":\"%s\"}\n",
      published ? "output" : "stage", expected_device, expected_inode, files[3].hash) != 0)
    return fail("helper-failed");
  if (fwrite(receipt, 1, used, stdout) != used || fflush(stdout) != 0) return 1;
  return 0;
}

/* Only a live accepted-payload EOF has a complete ledger of the bytes we wrote. */
static int cleanup_partial_tree(int parent, int stage, const struct stat *stage_identity,
                                int sources, const struct stat *sources_identity,
                                int module, const char *module_name,
                                const struct stat *module_identity, int resources,
                                const struct stat *resources_identity,
                                const struct artifact files[4],
                                const struct stat *journal_identity,
                                const char *journal, size_t journal_length) {
  const int directories[] = { stage, module, resources, stage };
  const char *names[] = {
    "Package.swift", "Shaders.generated.swift", "Shaders.metallib", ".vgpu-native-output.json"
  };
  struct artifact written[4];
  for (int index = 0; index < 4; index++) {
    written[index] = files[index];
    written[index].length = files[index].written_length;
    memcpy(written[index].hash, files[index].written_hash, sizeof(written[index].hash));
  }
  const char *root_entries[3] = { "Sources" };
  size_t root_count = 1;
  if (files[0].created) root_entries[root_count++] = names[0];
  if (files[3].created) root_entries[root_count++] = names[3];
  const char *sources_entries[] = { module_name };
  const char *module_entries[2] = { "Resources", "Shaders.generated.swift" };
  const char *resource_entries[] = { "Shaders.metallib" };
  if (directory_edge(parent, STAGE_NAME, stage, stage_identity) != 0 ||
      directory_edge(stage, "Sources", sources, sources_identity) != 0 ||
      directory_edge(sources, module_name, module, module_identity) != 0 ||
      directory_edge(module, "Resources", resources, resources_identity) != 0 ||
      exact_directory(stage, root_entries, root_count) != 0 ||
      exact_directory(sources, sources_entries, 1) != 0 ||
      exact_directory(module, module_entries, files[1].created ? 2 : 1) != 0 ||
      exact_directory(resources, resource_entries, files[2].created ? 1 : 0) != 0 ||
      ensure_absent(parent, UPDATE_NAME) != 0 ||
      verify_bytes(parent, JOURNAL_NAME, journal_identity, journal, journal_length) != 0)
    return -1;
  /* Check all contents before deleting any part of this transaction. */
  for (int index = 0; index < 4; index++)
    if (files[index].created && hash_file(directories[index], names[index], &written[index]) != 0)
      return -1;
  for (int index = 0; index < 4; index++)
    if (files[index].created && remove_artifact(directories[index], names[index], &written[index]) != 0)
      return -1;
  if (remove_empty_directory(module, "Resources", resources, resources_identity) != 0 ||
      remove_empty_directory(sources, module_name, module, module_identity) != 0 ||
      remove_empty_directory(stage, "Sources", sources, sources_identity) != 0 ||
      remove_empty_directory(parent, STAGE_NAME, stage, stage_identity) != 0 ||
      verify_bytes(parent, JOURNAL_NAME, journal_identity, journal, journal_length) != 0 ||
      unlinkat(parent, JOURNAL_NAME, 0) != 0)
    return -1;
  return 0;
}

int main(int argc, char **argv) {
  if ((argc != 6 && argc != 7 && argc != 9) || strcmp(argv[1], "vgpu-publication-staging/v1") != 0 ||
      (argc == 7 && strcmp(argv[6], "stage-only") != 0 && strcmp(argv[6], "publish-missing") != 0 &&
       strcmp(argv[6], "publish-missing-or-empty") != 0) ||
      (argc == 9 && strcmp(argv[6], "reconcile-missing") != 0 &&
       strcmp(argv[6], "reconcile-empty") != 0) ||
      !valid_transaction(argv[5])) {
    errno = EINVAL;
    return fail("helper-failed");
  }
  const char *parent_path = argv[2];
  const char *destination = argv[3];
  const char *module = argv[4];
  const char *transaction = argv[5];
  int allow_empty = argc == 7 && strcmp(argv[6], "publish-missing-or-empty") == 0;
  int publishing = allow_empty || (argc == 7 && strcmp(argv[6], "publish-missing") == 0);
  int reconciling = argc == 9;
  int reconcile_empty = reconciling && strcmp(argv[6], "reconcile-empty") == 0;
  unsigned long long expected_parent_device = 0;
  unsigned long long expected_parent_inode = 0;
  if (reconciling &&
      (parse_decimal(argv[7], &expected_parent_device) != 0 ||
       parse_decimal(argv[8], &expected_parent_inode) != 0 ||
       parent_path[0] != '/' || strlen(parent_path) >= PATH_MAX)) {
    errno = EINVAL;
    return fail("helper-failed");
  }
  int parent = reconciling ?
    open(parent_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC) : open_parent(parent_path);
  if (parent < 0) return fail("unsafe-parent");
  struct stat parent_identity;
  if (fstat(parent, &parent_identity) != 0) return fail("unsafe-parent");
  if (flock(parent, LOCK_EX | LOCK_NB) != 0)
    return fail(errno == EWOULDBLOCK ? "busy" : "helper-failed");
  if (reconciling &&
      ((unsigned long long)parent_identity.st_dev != expected_parent_device ||
       (unsigned long long)parent_identity.st_ino != expected_parent_inode)) {
    errno = ESTALE;
    return fail("parent-changed");
  }
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
  struct stat existing_journal;
  const struct reconciliation_request reconciliation = {
    destination, module, transaction, reconcile_empty
  };
  if (fstatat(parent, JOURNAL_NAME, &existing_journal, AT_SYMLINK_NOFOLLOW) == 0)
    return report_recovery(parent, parent_path, &parent_identity, &existing_journal, name_max,
                            reconciling ? &reconciliation : NULL);
  if (reconciling || errno != ENOENT) return fail("conflict");
  if (ensure_absent(parent, JOURNAL_NAME) != 0 ||
      ensure_absent(parent, UPDATE_NAME) != 0 || ensure_absent(parent, STAGE_NAME) != 0)
    return fail("conflict");

  int old_destination = -1;
  struct stat old_destination_identity = {0};
  int replace_empty = 0;
  if (allow_empty) {
    struct stat observed_destination;
    if (fstatat(parent, destination, &observed_destination, AT_SYMLINK_NOFOLLOW) == 0) {
      if (!S_ISDIR(observed_destination.st_mode) ||
          observed_destination.st_dev != parent_identity.st_dev ||
          same_identity(&observed_destination, &parent_identity)) {
        errno = EINVAL;
        return fail("conflict");
      }
      old_destination = open_child_directory(parent, destination);
      if (old_destination < 0 || fstat(old_destination, &old_destination_identity) != 0 ||
          directory_edge(parent, destination, old_destination, &observed_destination) != 0 ||
          exact_directory(old_destination, NULL, 0) != 0)
        return fail("conflict");
      replace_empty = 1;
    } else if (errno != ENOENT) {
      return fail("conflict");
    }
  } else if (ensure_absent(parent, destination) != 0) {
    return fail("conflict");
  }
  const struct stat *old_identity = replace_empty ? &old_destination_identity : NULL;

  char journal[JOURNAL_LIMIT];
  size_t journal_length = 0;
  struct stat journal_identity;
  if (build_journal(journal, sizeof(journal), "intent", transaction, destination,
                    module, publishing, old_identity, &parent_identity, NULL, NULL,
                    &journal_length) != 0 ||
      install_initial_journal(parent, journal, journal_length, &journal_identity) != 0)
    return fail("helper-failed");

  struct stat stage_identity;
  int stage = make_child_directory(parent, STAGE_NAME, &stage_identity);
  if (stage < 0) return fail("helper-failed");
  if (replace_empty && same_identity(&stage_identity, &old_destination_identity)) {
    errno = ESTALE;
    return fail("conflict");
  }
  int retained_update = 0;
  char next_journal[JOURNAL_LIMIT];
  size_t next_journal_length = 0;
  if (build_journal(next_journal, sizeof(next_journal), "staging", transaction, destination,
                    module, publishing, old_identity, &parent_identity, &stage_identity, NULL,
                    &next_journal_length) != 0 ||
      replace_owned_journal(parent, next_journal, next_journal_length, &journal_identity,
                            journal, journal_length, &retained_update) != 0)
    return fail_journal_update(retained_update);
  memcpy(journal, next_journal, next_journal_length + 1);
  journal_length = next_journal_length;

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
  const int directories[] = { stage, module_directory, resources, stage };
  const char *names[] = {
    "Package.swift", "Shaders.generated.swift", "Shaders.metallib", ".vgpu-native-output.json"
  };
  for (int index = 0; index < 4; index++) {
    int received = receive_file(stdin, directories[index], names[index], index, &files[index], &aggregate);
    if (received == 0) continue;
    int transfer_error = errno;
    if (received == TRANSFER_SHORT &&
        (!parent_matches(parent_path, &parent_identity) ||
         cleanup_partial_tree(parent, stage, &stage_identity, sources, &sources_identity,
                              module_directory, module, &module_identity, resources,
                              &resources_identity, files, &journal_identity, journal,
                              journal_length) != 0)) {
      int cleanup_error = errno;
      printf("{\"schemaVersion\":1,\"kind\":\"error\",\"code\":\"invalid-transfer\","
             "\"errno\":%d,\"cleanupCode\":\"cleanup-failed\",\"cleanupErrno\":%d}\n",
             transfer_error, cleanup_error);
      fflush(stdout);
      return 1;
    }
    if (received == TRANSFER_SHORT) {
      printf("{\"schemaVersion\":1,\"kind\":\"error\",\"code\":\"invalid-transfer\","
             "\"errno\":%d,\"cleanup\":\"cleaned\"}\n", transfer_error);
      fflush(stdout);
      return 1;
    }
    errno = transfer_error;
    return fail("invalid-transfer");
  }
  char command[64];
  if (fgets(command, sizeof(command), stdin) == NULL || strcmp(command, "prepare\n") != 0)
    return fail("invalid-transfer");
  if (!parent_matches(parent_path, &parent_identity)) return fail("parent-changed");
  if (verify_tree(parent, STAGE_NAME, stage, &stage_identity, sources, &sources_identity,
                  module_directory, module, &module_identity, resources,
                  &resources_identity, files) != 0)
    return fail("invalid-stage");
  if (build_journal(next_journal, sizeof(next_journal), "prepared", transaction, destination,
                    module, publishing, old_identity, &parent_identity, &stage_identity, files,
                    &next_journal_length) != 0 ||
      next_journal_length > JOURNAL_LIMIT ||
      replace_owned_journal(parent, next_journal, next_journal_length, &journal_identity,
                            journal, journal_length, &retained_update) != 0)
    return fail_journal_update(retained_update);
  memcpy(journal, next_journal, next_journal_length + 1);
  journal_length = next_journal_length;

  char receipt[JOURNAL_LIMIT];
  size_t receipt_length = 0;
  if (build_journal(receipt, sizeof(receipt), "prepared", transaction, destination,
                    module, publishing, old_identity, &parent_identity, &stage_identity, files,
                    &receipt_length) != 0)
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

  int published = 0;
  if (publishing) {
    char expected[64];
    snprintf(expected, sizeof(expected), "commit-%s %s prepared\n",
             replace_empty ? "empty" : "missing", transaction);
    if (fgets(command, sizeof(command), stdin) == NULL || strcmp(command, expected) != 0)
      return fail("helper-failed");

    const char *rejection = NULL;
    if (build_commit_receipt(receipt, sizeof(receipt), transaction, destination,
                             &parent_identity, &stage_identity, files[3].hash,
                             &receipt_length) != 0)
      rejection = "helper-failed";
    else if (!parent_matches(parent_path, &parent_identity))
      rejection = "parent-changed";
    else if (verify_tree(parent, STAGE_NAME, stage, &stage_identity, sources, &sources_identity,
                         module_directory, module, &module_identity, resources,
                         &resources_identity, files) != 0)
      rejection = "invalid-stage";
    else if (verify_bytes(parent, JOURNAL_NAME, &journal_identity, journal, journal_length) != 0 ||
             ensure_absent(parent, UPDATE_NAME) != 0)
      rejection = "conflict";
    else if (replace_empty &&
             (directory_edge(parent, destination, old_destination, &old_destination_identity) != 0 ||
              exact_directory(old_destination, NULL, 0) != 0))
      rejection = "conflict";
    else if (!replace_empty && ensure_absent(parent, destination) != 0)
      rejection = "conflict";
    else if (!parent_matches(parent_path, &parent_identity))
      rejection = "parent-changed";
    else if (renameatx_np(parent, STAGE_NAME, parent, destination,
                          (replace_empty ? 0 : RENAME_EXCL) | RENAME_NOFOLLOW_ANY) != 0)
      rejection = errno == EEXIST || (replace_empty && errno == ENOTEMPTY) ? "conflict" : "helper-failed";
    else
      published = 1; /* Historical syscall evidence, before acknowledgment or cleanup. */

    if (published) {
      if (fwrite(receipt, 1, receipt_length, stdout) != receipt_length || fflush(stdout) != 0)
        return 1;
    } else {
      int commit_error = errno;
      if (printf("{\"schemaVersion\":1,\"kind\":\"commit-result\",\"transactionId\":\"%s\","
                 "\"phase\":\"prepared\",\"outcome\":\"not-published\",\"code\":\"%s\","
                 "\"errno\":%d}\n", transaction, rejection, commit_error) < 0 || fflush(stdout) != 0)
        return 1;
    }
    snprintf(expected, sizeof(expected), "finalize %s %s\n", transaction,
             published ? "published" : "prepared");
    if (fgets(command, sizeof(command), stdin) == NULL || strcmp(command, expected) != 0)
      return fail("helper-failed");
  } else if (fgets(command, sizeof(command), stdin) == NULL || strcmp(command, "finalize\n") != 0)
    return fail("helper-failed");
  if (!parent_matches(parent_path, &parent_identity)) return fail("cleanup-failed");
  if (verify_tree(parent, published ? destination : STAGE_NAME, stage,
                  &stage_identity, sources, &sources_identity,
                  module_directory, module, &module_identity, resources,
                  &resources_identity, files) != 0)
    return fail("cleanup-failed");
  if ((publishing && ensure_absent(parent, UPDATE_NAME) != 0) ||
      (published && ensure_absent(parent, STAGE_NAME) != 0))
    return fail("cleanup-failed");
  if (verify_bytes(parent, JOURNAL_NAME, &journal_identity, journal, journal_length) != 0)
    return fail("cleanup-failed");
  if (!published) {
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
  }
  if (verify_bytes(parent, JOURNAL_NAME, &journal_identity, journal, journal_length) != 0 ||
      unlinkat(parent, JOURNAL_NAME, 0) != 0)
    return fail("cleanup-failed");
  if (publishing)
    printf("{\"schemaVersion\":1,\"kind\":\"finalized\",\"transactionId\":\"%s\",\"phase\":\"%s\"}\n",
           transaction, published ? "published" : "prepared");
  else
    puts("{\"schemaVersion\":1,\"kind\":\"finalized\"}");
  fflush(stdout);
  close(resources);
  close(module_directory);
  close(sources);
  close(stage);
  if (old_destination >= 0) close(old_destination);
  close(parent);
  return 0;
}
