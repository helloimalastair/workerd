// Copyright (c) 2017-2022 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

#pragma once
// Public API for setting up JavaScript context. Only high-level code needs to include this file.

#include "async-context.h"
#include "jsg.h"
#include "v8-platform-wrapper.h"

#include <workerd/jsg/observer.h>
#include <workerd/util/batch-queue.h>

#include <v8-profiler.h>

#include <kj/map.h>
#include <kj/mutex.h>
#include <kj/vector.h>

#include <typeindex>

namespace workerd::jsg {

class Deserializer;
class Serializer;

// Construct a default V8 platform, with the given background thread pool size.
//
// Passing zero for `backgroundThreadCount` causes V8 to ask glibc how many processors there are.
// Now, glibc *could* answer this problem easily by calling `sched_getaffinity()`, which would
// not only tell it how many cores exist, but also how many cores are available to this specific
// process. But does glibc do that? No, it does not. Instead, it frantically tries to open
// `/sys/devices/system/cpu/online`, then `/proc/stat`, then `/proc/cpuinfo`, and parses the text
// it reads from whichever file successfully opens to find out the number of processors. Of course,
// if you're in a sandbox, that probably won't work. And anyway, you probably don't actually want
// V8 to consume all available cores with background work. So, please specify a thread pool size.
kj::Own<v8::Platform> defaultPlatform(uint backgroundThreadCount);

// In order to use any part of the JSG API, you must first construct a V8System. You can only
// construct one of these per process. This performs process-wide initialization of the V8
// library.
class V8System {
  using PumpMsgLoopType = kj::Function<bool(v8::Isolate*)>;
  using ShutdownIsolateType = kj::Function<void(v8::Isolate*)>;

 public:
  // Uses the default v8::Platform implementation, as if by:
  //   auto v8Platform = jsg::defaultPlatform();
  //   auto v8System = V8System(*v8Platform, flags);
  // (Optional) `flags` is a list of command-line flags to pass to V8, like "--expose-gc" or
  // "--single_threaded_gc". An exception will be thrown if any flags are not recognized.
  explicit V8System(kj::ArrayPtr<const kj::StringPtr> flags = nullptr);

  // Use a possibly-custom v8::Platform wrapper over default v8::Platform, and apply flags.
  explicit V8System(v8::Platform& platform,
      kj::ArrayPtr<const kj::StringPtr> flags,
      v8::Platform* defaultPlatformPtr);

  // Use a possibly-custom v8::Platform implementation with custom task queue, and apply flags.
  explicit V8System(v8::Platform& platform,
      kj::ArrayPtr<const kj::StringPtr> flags,
      PumpMsgLoopType,
      ShutdownIsolateType);

  ~V8System() noexcept(false);

  using FatalErrorCallback = void(kj::StringPtr location, kj::StringPtr message);
  static void setFatalErrorCallback(FatalErrorCallback* callback);

 private:
  kj::Own<v8::Platform> platformInner;
  kj::Own<V8PlatformWrapper> platformWrapper;
  PumpMsgLoopType pumpMsgLoop;
  ShutdownIsolateType shutdownIsolate;
  friend class IsolateBase;

  void init(kj::Own<v8::Platform>,
      kj::ArrayPtr<const kj::StringPtr>,
      PumpMsgLoopType,
      ShutdownIsolateType);
};

// Base class of Isolate<T> containing parts that don't need to be templated, to avoid code
// bloat.
class IsolateBase {
 public:
  static IsolateBase& from(v8::Isolate* isolate);

  // Unwraps a JavaScript exception as a kj::Exception.
  virtual kj::Exception unwrapException(
      Lock& js, v8::Local<v8::Context> context, v8::Local<v8::Value> exception) = 0;

  // Wraps a kj::Exception as a JavaScript Exception.
  virtual v8::Local<v8::Value> wrapException(
      Lock& js, v8::Local<v8::Context> context, kj::Exception&& exception) = 0;

  // Used by Serializer/Deserializer implementations, calls into DynamicResourceTypeMap
  // serializerMap and deserializerMap.
  virtual bool serialize(
      Lock& js, std::type_index type, jsg::Object& instance, Serializer& serializer) = 0;
  virtual kj::Maybe<v8::Local<v8::Object>> deserialize(
      Lock& js, uint tag, Deserializer& deserializer) = 0;

  // Immediately cancels JavaScript execution in this isolate, causing an uncatchable exception to
  // be thrown. Safe to call across threads, without holding the lock.
  void terminateExecution() const;

  using Logger = Lock::Logger;
  inline void setLoggerCallback(kj::Badge<Lock>, kj::Function<Logger>&& logger) {
    maybeLogger = kj::mv(logger);
  }

  using ErrorReporter = Lock::ErrorReporter;
  inline void setErrorReporterCallback(kj::Badge<Lock>, kj::Function<ErrorReporter>&& reporter) {
    maybeErrorReporter = kj::mv(reporter);
  }

  using ModuleFallbackCallback = kj::Maybe<kj::OneOf<kj::String, jsg::ModuleRegistry::ModuleInfo>>(
      jsg::Lock&,
      kj::StringPtr,
      kj::Maybe<kj::String>,
      jsg::CompilationObserver&,
      jsg::ModuleRegistry::ResolveMethod,
      kj::Maybe<kj::StringPtr>);
  inline void setModuleFallbackCallback(kj::Function<ModuleFallbackCallback>&& callback) {
    maybeModuleFallbackCallback = kj::mv(callback);
  }
  inline kj::Maybe<kj::Function<ModuleFallbackCallback>&> tryGetModuleFallback() {
    KJ_IF_SOME(moduleFallbackCallback, maybeModuleFallbackCallback) {
      return moduleFallbackCallback;
    }
    return kj::none;
  }

  inline void setAllowEval(kj::Badge<Lock>, bool allow) {
    evalAllowed = allow;
  }
  inline void setJspiEnabled(kj::Badge<Lock>, bool enabled) {
    jspiEnabled = enabled;
  }
  inline void setCaptureThrowsAsRejections(kj::Badge<Lock>, bool capture) {
    captureThrowsAsRejections = capture;
  }

  inline void setNodeJsCompatEnabled(kj::Badge<Lock>, bool enabled) {
    nodeJsCompatEnabled = enabled;
  }

  inline void setNodeJsProcessV2Enabled(kj::Badge<Lock>, bool enabled) {
    nodeJsProcessV2Enabled = enabled;
  }

  inline bool areWarningsLogged() const {
    return maybeLogger != kj::none;
  }
  inline bool areErrorsReported() const {
    return maybeErrorReporter != kj::none;
  }

  inline bool isNodeJsCompatEnabled() const {
    return nodeJsCompatEnabled;
  }

  inline bool isNodeJsProcessV2Enabled() const {
    return nodeJsProcessV2Enabled;
  }

  inline bool shouldSetToStringTag() const {
    return setToStringTag;
  }

  void enableSetToStringTag() {
    setToStringTag = true;
  }

  inline void disableTopLevelAwait() {
    allowTopLevelAwait = false;
  }

  inline bool isTopLevelAwaitEnabled() const {
    return allowTopLevelAwait;
  }

  // The logger will be optionally set by the isolate setup logic if there is anywhere
  // for the log to go (for instance, if debug logging is enabled or the inspector is
  // being used).
  inline void logWarning(Lock& js, kj::StringPtr message) {
    KJ_IF_SOME(logger, maybeLogger) {
      logger(js, message);
    }
  }

  inline void reportError(
      Lock& js, kj::String desc, const JsValue& error, const JsMessage& message) {
    KJ_IF_SOME(reporter, maybeErrorReporter) {
      reporter(js, kj::mv(desc), error, message);
    }
  }

  IsolateObserver& getObserver() {
    return *observer;
  }

  // Implementation of MemoryRetainer
  void jsgGetMemoryInfo(MemoryTracker& tracker) const;
  kj::StringPtr jsgGetMemoryName() const {
    return "IsolateBase"_kjc;
  }
  size_t jsgGetMemorySelfSize() const {
    return sizeof(IsolateBase);
  }
  bool jsgGetMemoryInfoIsRootNode() const {
    return true;
  }

  // Get an object referencing this isolate that can be used to adjust external memory usage later
  kj::Arc<const ExternalMemoryTarget> getExternalMemoryTarget();

  // Equivalent to getExternalMemoryTarget()->getAdjustment(amount), but saves an atomic refcount
  // increment and decrement.
  ExternalMemoryAdjustment getExternalMemoryAdjustment(int64_t amount) {
    return externalMemoryTarget->getAdjustment(amount);
  }

  AsyncContextFrame::StorageKey& getEnvAsyncContextKey() {
    return *envAsyncContextKey;
  }

  void setUsingNewModuleRegistry() {
    usingNewModuleRegistry = true;
  }

  bool isUsingNewModuleRegistry() const {
    return usingNewModuleRegistry;
  }

  void setThrowOnUnrecognizedImportAssertion() {
    throwOnUnrecognizedImportAssertion = true;
  }

  bool getThrowOnUnrecognizedImportAssertion() const {
    return throwOnUnrecognizedImportAssertion;
  }

  bool pumpMsgLoop() {
    return v8System.pumpMsgLoop(ptr);
  }

 private:
  template <typename TypeWrapper>
  friend class Isolate;

  static void buildEmbedderGraph(v8::Isolate* isolate, v8::EmbedderGraph* graph, void* data);

  // The internals of a jsg::Ref<T> to be deleted.
  class RefToDelete {
   public:
    RefToDelete(bool strong, kj::Own<void> ownWrappable, Wrappable* wrappable)
        : strong(strong),
          ownWrappable(kj::mv(ownWrappable)),
          wrappable(wrappable) {}
    ~RefToDelete() noexcept(false) {
      if (ownWrappable.get() != nullptr && strong) {
        wrappable->removeStrongRef();
      }
    }
    RefToDelete(RefToDelete&&) = default;

    // Default move ctor okay because ownWrappable.get() will be null if moved-from.
    KJ_DISALLOW_COPY(RefToDelete);

   private:
    bool strong;
    // Keeps the `wrappable` pointer below valid.
    kj::Own<void> ownWrappable;
    Wrappable* wrappable;
  };

  using Item = kj::OneOf<v8::Global<v8::Data>, RefToDelete>;

  V8System& v8System;
  // TODO(cleanup): After v8 13.4 is fully released we can inline this into `newIsolate`
  //                and remove this member.
  std::unique_ptr<class v8::CppHeap> cppHeap;
  v8::Isolate* ptr;
  bool evalAllowed = false;
  bool jspiEnabled = false;

  // The Web Platform API specifications require that any API that returns a JavaScript Promise
  // should never throw errors synchronously. Rather, they are supposed to capture any synchronous
  // throws and return a rejected Promise. Historically, Workers did not follow that guideline
  // and there are a number of async APIs that currently throw. When the captureThrowsAsRejections
  // flag is set, that old behavior is changed to be correct.
  bool captureThrowsAsRejections = false;
  bool asyncContextTrackingEnabled = false;
  bool nodeJsCompatEnabled = false;
  bool nodeJsProcessV2Enabled = false;
  bool setToStringTag = false;
  bool allowTopLevelAwait = true;
  bool usingNewModuleRegistry = false;

  // Only used when the original module registry is used.
  bool throwOnUnrecognizedImportAssertion = false;

  kj::Maybe<kj::Function<Logger>> maybeLogger;
  kj::Maybe<kj::Function<ErrorReporter>> maybeErrorReporter;
  kj::Maybe<kj::Function<ModuleFallbackCallback>> maybeModuleFallbackCallback;

  // FunctionTemplate used by Wrappable::attachOpaqueWrapper(). Just a constructor for an empty
  // object with 2 internal fields.
  v8::Global<v8::FunctionTemplate> opaqueTemplate;

  // Object used as the underlying storage for a workers environment.
  v8::Global<v8::Object> workerEnvObj;

  /* *** External Memory accounting *** */
  // ExternalMemoryTarget holds a weak reference back to the isolate. ExternalMemoryAjustments
  // hold references to the ExternalMemoryTarget. This allows the ExternalMemoryAjustments to
  // outlive the isolate.
  kj::Arc<const ExternalMemoryTarget> externalMemoryTarget;

  // A shared async context key for accessing env
  kj::Own<AsyncContextFrame::StorageKey> envAsyncContextKey;

  // We expect queues to remain relatively small -- 8 is the largest size I have observed from local
  // testing.
  static constexpr auto DESTRUCTION_QUEUE_INITIAL_SIZE = 8;

  // If a queue grows larger than this, we reset it back to the initial size.
  static constexpr auto DESTRUCTION_QUEUE_MAX_CAPACITY = 10'000;

  // We use a double buffer for our deferred destruction queue. This allows us to avoid any
  // allocations in the general, steady state case, and forces us to clear the vector (a O(n)
  // operation) outside of the queue lock.
  const kj::MutexGuarded<BatchQueue<Item>> queue{
    DESTRUCTION_QUEUE_INITIAL_SIZE, DESTRUCTION_QUEUE_MAX_CAPACITY};

  struct CodeBlockInfo {
    size_t size = 0;
    kj::Maybe<v8::JitCodeEvent::CodeType> type;
    kj::String name;

    struct PositionMapping {
      uint instructionOffset;
      uint sourceOffset;
    };
    kj::Array<PositionMapping> mapping;
    // Sorted
  };

  // Maps instructions to source code locations.
  kj::TreeMap<uintptr_t, CodeBlockInfo> codeMap;

  explicit IsolateBase(V8System& system,
      v8::Isolate::CreateParams&& createParams,
      kj::Own<IsolateObserver> observer,
      v8::IsolateGroup group);
  ~IsolateBase() noexcept(false);
  KJ_DISALLOW_COPY_AND_MOVE(IsolateBase);

  void dropWrappers(kj::FunctionParam<void()> drop);

  bool getCaptureThrowsAsRejections() const {
    return captureThrowsAsRejections;
  }

  // Add an item to the deferred destruction queue. Safe to call from any thread at any time.
  void deferDestruction(Item item);

  // Destroy everything in the deferred destruction queue and apply deferred external memory
  // updates. Called each time a lock is taken. Must be called under the isolate lock.
  void applyDeferredActions();

  static void fatalError(const char* location, const char* message);
  static void oomError(const char* location, const v8::OOMDetails& details);

  static v8::ModifyCodeGenerationFromStringsResult modifyCodeGenCallback(
      v8::Local<v8::Context> context, v8::Local<v8::Value> source, bool isCodeLike);
  static bool allowWasmCallback(v8::Local<v8::Context> context, v8::Local<v8::String> source);
  static bool jspiEnabledCallback(v8::Local<v8::Context> context);

  static void jitCodeEvent(const v8::JitCodeEvent* event) noexcept;

  friend kj::Maybe<kj::StringPtr> getJsStackTrace(void* ucontext, kj::ArrayPtr<char> scratch);

  HeapTracer heapTracer;
  kj::Own<IsolateObserver> observer;

  friend class Data;
  friend class Wrappable;
  friend class HeapTracer;
  friend class ExternalMemoryTarget;

  friend bool getCaptureThrowsAsRejections(v8::Isolate* isolate);
  friend kj::Maybe<kj::StringPtr> getJsStackTrace(void* ucontext, kj::ArrayPtr<char> scratch);

  friend kj::Exception createTunneledException(
      v8::Isolate* isolate, v8::Local<v8::Value> exception);

  // Get a singleton ObjectTemplate used for opaque wrappers (which have an empty-object interface
  // in JavaScript). (Called by Wrappable::attachOpaqueWrapper().)
  //
  // This returns a FunctionTemplate which should be used as a constructor. That is, you can use
  // use `->InstanceTemplate()->NewInstance()` to construct an object, and you can pass this to
  // `FindInstanceInPrototypeChain()` on an existing object to check whether it was created using
  // this template.
  static v8::Local<v8::FunctionTemplate> getOpaqueTemplate(v8::Isolate* isolate);
};

// If JavaScript frames are currently on the stack, returns a string representing a stack trace
// through it. The trace is built inside `scratch` without performing any allocation. This is
// intended to be invoked from a signal handler.
kj::Maybe<kj::StringPtr> getJsStackTrace(void* ucontext, kj::ArrayPtr<char> scratch);

// Set the location of the pointer cage base for the current isolate.  This is only
// used by getJsCageBase().
void setJsCageBase(void* cageBase);

// Get the location previously set by setJsCageBase() for the current isolate.  Returns
// a null pointer if there is no current isolate.
void* getJsCageBase();

// Class representing a JavaScript execution engine, with the ability to wrap some set of API
// classes which you specify.
//
// To use this, you must declare your own custom specialization listing all of the API types that
// you want to support in this JavaScript context. API types are types which have
// JSG_RESOURCE_TYPE or JSG_STRUCT declarations, as well as TypeWrapperExtensions.
//
// To declare a specialization, do:
//
//     JSG_DECLARE_ISOLATE_TYPE(MyIsolateType, MyApiType1, MyApiType2, ...);
//
// This declares a class `MyIsolateType` which is a subclass of Isolate. You can then
// instantiate this class to begin executing JavaScript.
//
// You can instantiate multiple Isolates which can run on separate threads simultaneously.
//
// Example usage:
//
//     // Create once per process, probably in main().
//     V8System system;
//
//     // Create an isolate with the ability to wrap MyType and MyContextType.
//     JSG_DECLARE_ISOLATE_TYPE(MyIsolate, MyApiType, MyContextApiType);
//     MyIsolate isolate(system);
//
//     // Lock the isolate in this thread (creates a v8::Isolate::Scope).
//     isolate.runInLockScope([&] (MyIsolate::Lock& lock) {
//       // Create a context based on MyContextType.
//       v8::Local<v8::Context> context = lock.newContext(lock.isolate, MyContextType());
//
//       // Create an instance of MyType.
//       v8::Local<v8::Object> obj = lock.getTypeHandler<MyType>().wrap(lock, context, MyType());
//     });
//
template <typename TypeWrapper>
class Isolate: public IsolateBase {
 public:
  // Construct an isolate that requires configuration. `configuration` is a value that all
  // individual wrappers' configurations must be able to be constructed from. For example, if all
  // wrappers use the same configuration type, then `MetaConfiguration` should just be that type.
  // If different wrappers use different types, then `MetaConfiguration` should be some value that
  // inherits or defines conversion operators to each required type -- or the individual
  // configuration types must declare constructors from `MetaConfiguration`.
  // If `instantiateTypeWrapper` is false, then the default wrapper will not be instantiated
  // and should be instantiated with `instantiateTypeWrapper` before `newContext` is called on
  // a jsg::Lock of this Isolate.
  //
  // If using v8 sandboxing, the group argument controls which isolates share a
  // sandbox, and which are isolated (as much as possible) in the event of a
  // heap corruption attack. Note: The isolates in a group are limited to at
  // most 4Gbytes of V8 heap in all.  Groups can be created with
  // v8::IsolateGroup::Create().  (If using V8 pointer compression, this
  // requires the enable_pointer_compression_multiple_cages build flag for V8.)
  // Pass v8::IsolateGroup::Default() as the group to put all isolates in the
  // same group.
  template <typename MetaConfiguration>
  explicit Isolate(V8System& system,
      v8::IsolateGroup group,
      MetaConfiguration&& configuration,
      kj::Own<IsolateObserver> observer,
      v8::Isolate::CreateParams createParams = {},
      bool instantiateTypeWrapper = true)
      : IsolateBase(system, kj::mv(createParams), kj::mv(observer), group) {
    wrappers.resize(1);
    if (instantiateTypeWrapper) {
      instantiateDefaultWrapper(kj::fwd<MetaConfiguration>(configuration));
    }
  }

  // Legacy isolate constructor that creates a new IsolateGroup for the new
  // Isolate.  Currently used by non-sandboxing edgeworker, but deprecated.
  template <typename MetaConfiguration>
  explicit Isolate(V8System& system,
      MetaConfiguration&& configuration,
      kj::Own<IsolateObserver> observer,
      v8::Isolate::CreateParams createParams = {},
      bool instantiateTypeWrapper = true)
      : IsolateBase(system, kj::mv(createParams), kj::mv(observer), v8::IsolateGroup::Create()) {
    wrappers.resize(1);
    if (instantiateTypeWrapper) {
      instantiateDefaultWrapper(kj::fwd<MetaConfiguration>(configuration));
    }
  }

  // Use this constructor when no wrappers have any required configuration.
  explicit Isolate(V8System& system,
      kj::Own<IsolateObserver> observer,
      v8::Isolate::CreateParams createParams = {})
      : Isolate(system,
            v8::IsolateGroup::GetDefault(),
            nullptr,
            kj::mv(observer),
            kj::mv(createParams)) {}

  template <typename MetaConfiguration>
  void instantiateDefaultWrapper(MetaConfiguration&& configuration) {
    KJ_DASSERT(wrappers[0].get() == nullptr);
    auto wrapper = wrapperSpace.construct(ptr, kj::fwd<MetaConfiguration>(configuration));
    wrapper->initTypeWrapper();
    wrappers[0] = kj::mv(wrapper);
  }

  ~Isolate() noexcept(false) {
    dropWrappers([this]() { wrappers.clear(); });
  }

  kj::Exception unwrapException(
      Lock& js, v8::Local<v8::Context> context, v8::Local<v8::Value> exception) override {
    return getWrapperByContext(context)->template unwrap<kj::Exception>(
        js, context, exception, jsg::TypeErrorContext::other());
  }

  v8::Local<v8::Value> wrapException(
      Lock& js, v8::Local<v8::Context> context, kj::Exception&& exception) override {
    return getWrapperByContext(context)->wrap(
        js, context, kj::none, kj::fwd<kj::Exception>(exception));
  }

  bool serialize(
      Lock& js, std::type_index type, jsg::Object& instance, Serializer& serializer) override {
    auto* wrapper = getWrapperByContext(js);
    KJ_IF_SOME(func, wrapper->serializerMap.find(type)) {
      func(*wrapper, js, instance, serializer);
      return true;
    } else {
      return false;
    }
  }
  kj::Maybe<v8::Local<v8::Object>> deserialize(
      Lock& js, uint tag, Deserializer& deserializer) override {
    auto* wrapper = getWrapperByContext(js);
    KJ_IF_SOME(func, wrapper->deserializerMap.find(tag)) {
      return func(*wrapper, js, tag, deserializer);
    } else {
      return kj::none;
    }
  }

  // Before you can execute code in your Isolate you must lock it to the current thread by
  // constructing a `Lock` on the stack.
  class Lock final: public jsg::Lock {

   public:
    // `V8StackScope` must be provided to prove that one has been created on the stack before
    // taking a lock. Any GC'ed pointers stored on the stack must be kept within this scope in
    // order for V8's stack-scanning GC to find them.
    Lock(const Isolate& isolate, V8StackScope&)
        : jsg::Lock(isolate.ptr),
          jsgIsolate(const_cast<Isolate&>(isolate)) {
      jsgIsolate.applyDeferredActions();
    }
    KJ_DISALLOW_COPY_AND_MOVE(Lock);
    KJ_DISALLOW_AS_COROUTINE_PARAM;

    // Creates a `TypeHandler` for the given type. You can use this to convert between the type
    // and V8 handles, as well as to allocate instances of the type on the V8 heap (if it is
    // a resource type).
    template <typename T>
    const TypeHandler<T>& getTypeHandler() {
      return TypeWrapper::template TYPE_HANDLER_INSTANCE<T>;
    }

    // Wrap a C++ value, returning a v8::Local (possibly of a specific type).
    template <typename T>
    auto wrap(v8::Local<v8::Context> context, T&& value) {
      return jsgIsolate.getWrapperByContext(context)->wrap(
          *this, context, kj::none, kj::fwd<T>(value));
    }

    // Wrap a context-independent value. Only a few built-in types, like numbers and strings,
    // can be wrapped without a context.
    template <typename T>
    auto wrapNoContext(T&& value) {
      return jsgIsolate.getWrapperByContext(*this)->wrap(v8Isolate, kj::none, kj::fwd<T>(value));
    }

    // Convert a JavaScript value to a C++ value, or throw a JS exception if the type doesn't
    // match.
    template <typename T>
    auto unwrap(v8::Local<v8::Context> context, v8::Local<v8::Value> handle) {
      return jsgIsolate.getWrapperByContext(context)->template unwrap<T>(
          *this, context, handle, jsg::TypeErrorContext::other());
    }

    Ref<DOMException> domException(
        kj::String name, kj::String message, kj::Maybe<kj::String> maybeStack) override {
      return withinHandleScope([&] {
        v8::Local<v8::FunctionTemplate> tmpl = jsgIsolate.getWrapperByContext(*this)->getTemplate(
            v8Isolate, static_cast<DOMException*>(nullptr));
        KJ_DASSERT(!tmpl.IsEmpty());
        v8::Local<v8::Object> obj = check(tmpl->InstanceTemplate()->NewInstance(v8Context()));
        v8::Local<v8::String> stackName = str("stack"_kjc);

        KJ_IF_SOME(stack, maybeStack) {
          v8::PropertyDescriptor prop(str(stack), true);
          prop.set_enumerable(true);
          jsg::check(obj->DefineProperty(v8Context(), stackName, prop));
        } else {
          v8::Exception::CaptureStackTrace(v8Context(), obj);
          v8::PropertyDescriptor prop;
          prop.set_enumerable(true);
          jsg::check(obj->DefineProperty(v8Context(), stackName, prop));
        }

        auto de = alloc<DOMException>(kj::mv(message), kj::mv(name));
        de.attachWrapper(v8Isolate, obj);

        return kj::mv(de);
      });
    }

    // Returns the constructor function for a given type declared as JSG_RESOURCE_TYPE.
    //
    // Note there's a useful property of class constructor functions: A constructor's __proto__
    // is set to the parent type's constructor. Thus you can discover whether one class is a
    // subclass of another by following the __proto__ chain.
    //
    // TODO(cleanup): This should return `JsFunction`, but there is no such type. We only have
    //   `jsg::Function<...>` (or perhaps more appropriately, `jsg::Constructor<...>`), but we
    //   don't actually know the function signature so that's not useful here. Should we add a
    //   `JsFunction` that has no signature?
    template <typename T>
    jsg::JsObject getConstructor(v8::Local<v8::Context> context) {
      v8::EscapableHandleScope scope(v8Isolate);
      v8::Local<v8::FunctionTemplate> tpl =
          jsgIsolate.getWrapperByContext(context)->getTemplate(v8Isolate, (T*)nullptr);
      v8::Local<v8::Object> prototype = check(tpl->GetFunction(context));
      return jsg::JsObject(scope.Escape(prototype));
    }

    v8::Local<v8::ArrayBuffer> wrapBytes(kj::Array<byte> data) override {
      return jsgIsolate.getWrapperByContext(*this)->wrap(v8Isolate, kj::none, kj::mv(data));
    }
    v8::Local<v8::Function> wrapSimpleFunction(v8::Local<v8::Context> context,
        jsg::Function<void(const v8::FunctionCallbackInfo<v8::Value>& info)> simpleFunction)
        override {
      return jsgIsolate.getWrapperByContext(context)->wrap(
          *this, context, kj::none, kj::mv(simpleFunction));
    }
    v8::Local<v8::Function> wrapReturningFunction(v8::Local<v8::Context> context,
        jsg::Function<v8::Local<v8::Value>(const v8::FunctionCallbackInfo<v8::Value>& info)>
            returningFunction) override {
      return jsgIsolate.getWrapperByContext(context)->wrap(
          *this, context, kj::none, kj::mv(returningFunction));
    }
    v8::Local<v8::Function> wrapPromiseReturningFunction(v8::Local<v8::Context> context,
        jsg::Function<jsg::Promise<jsg::Value>(const v8::FunctionCallbackInfo<v8::Value>& info)>
            returningFunction) override {
      return jsgIsolate.getWrapperByContext(context)->wrap(
          *this, context, kj::none, kj::mv(returningFunction));
    }
    kj::String toString(v8::Local<v8::Value> value) override {
      return jsgIsolate.getWrapperByContext(*this)->template unwrap<kj::String>(
          *this, v8Isolate->GetCurrentContext(), value, jsg::TypeErrorContext::other());
    }
    jsg::Dict<v8::Local<v8::Value>> toDict(v8::Local<v8::Value> value) override {
      return jsgIsolate.getWrapperByContext(*this)
          ->template unwrap<jsg::Dict<v8::Local<v8::Value>>>(
              *this, v8Isolate->GetCurrentContext(), value, jsg::TypeErrorContext::other());
    }
    jsg::Dict<jsg::JsValue> toDict(const jsg::JsValue& value) override {
      return jsgIsolate.getWrapperByContext(*this)->template unwrap<jsg::Dict<jsg::JsValue>>(
          *this, v8Isolate->GetCurrentContext(), value, jsg::TypeErrorContext::other());
    }
    v8::Local<v8::Promise> wrapSimplePromise(jsg::Promise<jsg::Value> promise) override {
      return jsgIsolate.getWrapperByContext(*this)->wrap(
          *this, v8Context(), kj::none, kj::mv(promise));
    }
    jsg::Promise<jsg::Value> toPromise(v8::Local<v8::Value> promise) override {
      return jsgIsolate.getWrapperByContext(*this)->template unwrap<jsg::Promise<jsg::Value>>(
          *this, v8Isolate->GetCurrentContext(), promise, jsg::TypeErrorContext::other());
    }

    template <typename T, typename... Args>
    JsContext<T> newContextWithWrapper(
        TypeWrapper* wrapper, NewContextOptions options, Args&&... args) {
      // TODO(soon): Requiring move semantics for the global object is awkward. This should instead
      //   allocate the object (forwarding arguments to the constructor) and return something like
      //   a Ref.
      auto context = wrapper->newContext(*this, options, jsgIsolate.getObserver(),
          static_cast<T*>(nullptr), kj::fwd<Args>(args)...);
      context.getHandle(v8Isolate)->SetAlignedPointerInEmbedderData(3, wrapper);
      return context;
    }

    // Creates a new JavaScript "context", i.e. the global object. This is the first step to
    // executing JavaScript code. T should be one of your API types which you want to use as the
    // global object. `args...` are passed to the type's constructor.
    template <typename T, typename... Args>
    JsContext<T> newContext(NewContextOptions options, Args&&... args) {
      KJ_DASSERT(!jsgIsolate.wrappers.empty());
      KJ_DASSERT(jsgIsolate.wrappers[0].get() != nullptr);
      return newContextWithWrapper<T>(
          jsgIsolate.wrappers[0].get(), options, kj::fwd<Args>(args)...);
    }

    // Creates a new JavaScript "context", i.e. the global object. This is the first step to
    // executing JavaScript code. T should be one of your API types which you want to use as the
    // global object. `args...` are passed to the type's constructor.
    template <typename T, typename... Args>
    JsContext<T> newContext(Args&&... args) {
      return newContext<T>(NewContextOptions{}, kj::fwd<Args>(args)...);
    }

    template <typename T, typename MetaConfiguration, typename... Args>
    JsContext<T> newContextWithConfiguration(
        MetaConfiguration&& configuration, NewContextOptions options, Args&&... args) {
      jsgIsolate.hasExtraWrappers = true;
      auto& wrapper = jsgIsolate.wrappers.add(
          kj::heap<TypeWrapper>(jsgIsolate.ptr, kj::fwd<MetaConfiguration>(configuration)));
      return newContextWithWrapper<T>(wrapper.get(), options, kj::fwd<Args>(args)...);
    }

    void reportError(const JsValue& value) override {
      auto& js = Lock::from(v8Isolate);
      KJ_IF_SOME(domException,
          jsgIsolate.getWrapperByContext(*this)->tryUnwrap(
              js, v8Context(), value, static_cast<DOMException*>(nullptr), kj::none)) {
        auto desc =
            kj::str("DOMException(", domException.getName(), "): ", domException.getMessage());
        jsgIsolate.reportError(*this, kj::mv(desc), value, JsMessage::create(*this, value));
      } else {
        jsgIsolate.reportError(
            *this, value.toString(*this), value, JsMessage::create(*this, value));
      }
    }

    void setWorkerEnv(V8Ref<v8::Object> value) override {
      jsgIsolate.workerEnvObj.Reset(v8Isolate, value.getHandle(*this));
    }

    kj::Maybe<V8Ref<v8::Object>> getWorkerEnv() override {
      if (jsgIsolate.workerEnvObj.IsEmpty()) return kj::none;
      return v8Ref<v8::Object>(jsgIsolate.workerEnvObj.Get(v8Isolate));
    }

   private:
    Isolate& jsgIsolate;

    virtual kj::Maybe<Object&> getInstance(
        v8::Local<v8::Object> obj, const std::type_info& type) override {
      auto instance = v8::Local<v8::Object>(obj)->FindInstanceInPrototypeChain(
          jsgIsolate.getWrapperByContext(*this)->getDynamicTypeInfo(v8Isolate, type).tmpl);
      if (instance.IsEmpty()) {
        return kj::none;
      } else {
        return *reinterpret_cast<Object*>(
            instance->GetAlignedPointerFromInternalField(Wrappable::WRAPPED_OBJECT_FIELD_INDEX));
      }
    }

    virtual v8::Local<v8::Object> getPrototypeFor(const std::type_info& type) override {
      v8::EscapableHandleScope scope(v8Isolate);
      auto tmpl = jsgIsolate.getWrapperByContext(*this)->getDynamicTypeInfo(v8Isolate, type).tmpl;
      auto constructor = JsObject(check(tmpl->GetFunction(v8Context())));

      // Note that `constructor.getPrototype()` returns the prototype of the constructor itself,
      // which is NOT the same as the prototype of the object it constructs. For the latter we
      // need to access the `prototype` property.
      auto proto = constructor.get(*this, "prototype");

      KJ_ASSERT(proto.isObject());
      return scope.Escape(v8::Local<v8::Value>(proto).As<v8::Object>());
    }
  };

  // The func must be a callback with the signature: T(jsg::Lock&)
  // Be careful not to leak v8 objects outside of the scope.
  auto runInLockScope(auto func) {
    return runInV8Stack([&](V8StackScope& stackScope) {
      Lock lock(*this, stackScope);
      return lock.withinHandleScope([&] { return func(lock); });
    });
  }

 protected:
  inline TypeWrapper* getWrapperByContext(jsg::Lock& js) {
    if (KJ_LIKELY(!hasExtraWrappers)) {
      return wrappers[0].get();
    } else {
      return getWrapperByContext(js.v8Context());
    }
  }
  inline TypeWrapper* getWrapperByContext(v8::Local<v8::Context> context) {
    if (KJ_LIKELY(!hasExtraWrappers)) {
      return wrappers[0].get();
    } else {
      auto ptr = context->GetAlignedPointerFromEmbedderData(3);
      if (KJ_LIKELY(ptr != nullptr)) {
        return static_cast<TypeWrapper*>(ptr);
      } else {
        // This can happen when we create dummy contexts such as in worker.c++.
        return wrappers[0].get();
      }
    }
  }

 private:
  kj::SpaceFor<TypeWrapper> wrapperSpace;
  kj::Vector<kj::Own<TypeWrapper>> wrappers;  // Needs to be destroyed under lock...
  // This is just an optimization boolean, when we only have one wrapper we can skip calling
  // GetAlignedPointerFromEmbedderData and just return wrappers[0].
  bool hasExtraWrappers = false;
};

}  // namespace workerd::jsg
