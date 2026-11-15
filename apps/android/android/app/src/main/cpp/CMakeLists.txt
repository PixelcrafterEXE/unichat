cmake_minimum_required(VERSION 3.22.1)
project(unimsg_node CXX)

# nodejs-mobile prebuilt, unpacked by scripts/fetch-nodejs-mobile.mjs into app/libnode/{include,bin/<abi>/libnode.so}
set(LIBNODE ${CMAKE_SOURCE_DIR}/../../../libnode)

add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION ${LIBNODE}/bin/${ANDROID_ABI}/libnode.so)

add_library(unimsg-node SHARED native-lib.cpp)
target_include_directories(unimsg-node PRIVATE ${LIBNODE}/include/node)
target_compile_features(unimsg-node PRIVATE cxx_std_17)
target_link_libraries(unimsg-node node log)
