// JNI glue for nodejs-mobile: runs node::Start() and forwards stdout/stderr to logcat.
// Modelled on the glue in nodejs-mobile-cordova / nodejs-mobile-react-native (same node::Start entry point).
#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <unistd.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include "node.h"   // from libnode/include/node

#define TAG "UnimsgNode"

static int pfd[2];
static void *log_pump(void *) {
  char buf[2048];
  std::string line;
  ssize_t n;
  while ((n = read(pfd[0], buf, sizeof(buf))) > 0) {
    for (ssize_t i = 0; i < n; i++) {
      if (buf[i] == '\n') { __android_log_write(ANDROID_LOG_INFO, TAG, line.c_str()); line.clear(); }
      else line.push_back(buf[i]);
    }
  }
  return nullptr;
}
static void redirect_output() {
  setvbuf(stdout, nullptr, _IOLBF, 0);
  setvbuf(stderr, nullptr, _IONBF, 0);
  pipe(pfd);
  dup2(pfd[1], STDOUT_FILENO);
  dup2(pfd[1], STDERR_FILENO);
  pthread_t t;
  if (pthread_create(&t, nullptr, log_pump, nullptr) == 0) pthread_detach(t);
}

extern "C" JNIEXPORT jint JNICALL
Java_app_unimsg_android_node_NodeRuntime_nativeStart(JNIEnv *env, jclass, jobjectArray args) {
  static bool redirected = false;
  if (!redirected) { redirect_output(); redirected = true; }

  jsize argc = env->GetArrayLength(args);
  // libuv requires argv to live in ONE contiguous block (it rewrites the process title in place)
  std::vector<std::string> a;
  size_t total = 0;
  for (jsize i = 0; i < argc; i++) {
    auto s = (jstring)env->GetObjectArrayElement(args, i);
    const char *c = env->GetStringUTFChars(s, nullptr);
    a.emplace_back(c);
    env->ReleaseStringUTFChars(s, c);
    total += a.back().size() + 1;
  }
  char *block = (char *)calloc(total + 1, 1);
  char **argv = (char **)calloc(argc + 1, sizeof(char *));
  char *p = block;
  for (jsize i = 0; i < argc; i++) { argv[i] = p; memcpy(p, a[i].c_str(), a[i].size() + 1); p += a[i].size() + 1; }
  __android_log_print(ANDROID_LOG_INFO, TAG, "node::Start argc=%d argv[1]=%s", (int)argc, argc > 1 ? argv[1] : "");
  int rc = node::Start(argc, argv);
  __android_log_print(ANDROID_LOG_INFO, TAG, "node::Start returned %d", rc);
  return rc;
}
