// Offline reader for a selected list of installed PakV4 assets.
// Uses the installed, signed game engine's exported file API. No game injection,
// HTTP initialization, package modification, or recursive bulk extraction.
#include <windows.h>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

using OpenPakFile = void* (__fastcall*)(const char*);
using InitMemory = int (__fastcall*)(const char*);
using MountPak = int (__fastcall*)(const char*, const char*, void*, int, int, int, char, int, void*);
using ExistsInPak = int (__fastcall*)(const char*,int);
using DataInPak = int (__fastcall*)(const char*,int,uint64_t*);

std::string narrow(const std::wstring& value, UINT codepage) {
    int count=WideCharToMultiByte(codepage,0,value.c_str(),int(value.size()),nullptr,0,nullptr,nullptr);
    std::string result(count,'\0');
    WideCharToMultiByte(codepage,0,value.c_str(),int(value.size()),result.data(),count,nullptr,nullptr);
    return result;
}
std::wstring wide(const std::string& value) {
    int count=MultiByteToWideChar(936,MB_ERR_INVALID_CHARS,value.data(),int(value.size()),nullptr,0);
    if(!count) return {};
    std::wstring result(count,L'\0');
    MultiByteToWideChar(936,MB_ERR_INVALID_CHARS,value.data(),int(value.size()),result.data(),count);
    return result;
}
bool safe_path(std::string& path) {
    for(char& c:path) if(c=='\\') c='/';
    if(path.empty()||path[0]=='/'||path.find(':')!=std::string::npos||path.find('\0')!=std::string::npos) return false;
    for(size_t start=0;start<path.size();) {
        size_t end=path.find('/',start);
        auto part=path.substr(start,end==std::string::npos?path.size()-start:end-start);
        if(part.empty()||part=="."||part=="..") return false;
        if(end==std::string::npos) break;
        start=end+1;
    }
    return true;
}

int wmain(int argc,wchar_t** argv) {
    if(argc!=5) { puts("usage: read_client_assets <bin64> <Pakv4> <gbk-list> <output>"); return 2; }
    SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX|SEM_NOOPENFILEERRORBOX);
    const auto bindir=std::filesystem::absolute(argv[1]);
    const auto pakdir=std::filesystem::absolute(argv[2]);
    const auto output=std::filesystem::absolute(argv[4]);
    std::filesystem::create_directories(output);
    SetDllDirectoryW(bindir.c_str());
    HMODULE engine=LoadLibraryExW((bindir/L"Engine_Lua5X64.dll").c_str(),nullptr,LOAD_WITH_ALTERED_SEARCH_PATH);
    HMODULE filesystem=LoadLibraryExW((bindir/L"KGPK4_FileSystemX64.dll").c_str(),nullptr,LOAD_WITH_ALTERED_SEARCH_PATH);
    if(!engine||!filesystem) { printf("LOAD_ERROR %lu\n",GetLastError()); return 3; }
    auto mount=reinterpret_cast<MountPak>(GetProcAddress(engine,"KG_InitPakV4FileSystem"));
    auto open=reinterpret_cast<OpenPakFile>(GetProcAddress(engine,"g_OpenFileInPak"));
    auto initialize=reinterpret_cast<InitMemory>(GetProcAddress(engine,"?Initialize@KMemory@@YAHQEBD@Z"));
    auto exists=reinterpret_cast<ExistsInPak>(GetProcAddress(engine,"KG_IsPakV4FileExist"));
    auto dataExists=reinterpret_cast<DataInPak>(GetProcAddress(engine,"KG_IsPakV4FileDataExist"));
    if(!mount||!open||!initialize) { puts("MISSING_EXPORT"); return 4; }
    initialize(nullptr);
    char state=0;
    const std::string package=narrow(pakdir.wstring(),936);
    int mounted=mount(package.c_str(),"Trunk.dir",nullptr,0,0,0,0,0,&state);
    printf("MOUNT %d\n",mounted); fflush(stdout);
    if(mounted!=1) return 5;
    std::ifstream list{std::filesystem::path(argv[3]),std::ios::binary};
    if(!list) return 6;
    size_t ok=0,missing=0,failed=0,existing=0;
    std::string path;
    while(std::getline(list,path)) {
        if(!path.empty()&&path.back()=='\r') path.pop_back();
        if(!safe_path(path)) { ++failed; puts("INVALID_PATH"); continue; }
        auto relative=wide(path);
        if(relative.empty()) { ++failed; puts("INVALID_ENCODING"); continue; }
        const auto destination=output/std::filesystem::path(relative);
        std::string label=narrow(relative,CP_UTF8);
        if(std::filesystem::exists(destination)) { ++existing; printf("EXISTS %s\n",label.c_str()); continue; }
        void* file=open(path.c_str());
        if(!file) {
            uint64_t local=0;
            int present=exists?exists(path.c_str(),1):-1;
            int dataResult=dataExists?dataExists(path.c_str(),1,&local):-1;
            ++missing; printf("MISS indexed=%d data_result=%d local=%llu %s\n",present,dataResult,
                              (unsigned long long)local,label.c_str()); continue;
        }
        auto table=*reinterpret_cast<void***>(file);
        auto size=reinterpret_cast<uint64_t(__fastcall*)(void*)>(table[5])(file);
        if(size==0||size>64ull*1024*1024) {
            reinterpret_cast<void(__fastcall*)(void*)>(table[12])(file);
            ++failed; printf("SIZE_ERROR %s %llu\n",label.c_str(),(unsigned long long)size); continue;
        }
        std::vector<unsigned char> data(size);
        auto got=reinterpret_cast<uint64_t(__fastcall*)(void*,void*,uint64_t)>(table[0])(file,data.data(),size);
        reinterpret_cast<void(__fastcall*)(void*)>(table[12])(file);
        if(got!=size) { ++failed; printf("READ_ERROR %s\n",label.c_str()); continue; }
        std::filesystem::create_directories(destination.parent_path());
        HANDLE out=CreateFileW(destination.c_str(),GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr);
        DWORD written=0;
        bool success=out!=INVALID_HANDLE_VALUE&&WriteFile(out,data.data(),DWORD(size),&written,nullptr)&&written==size;
        if(out!=INVALID_HANDLE_VALUE) CloseHandle(out);
        if(!success) { ++failed; printf("WRITE_ERROR %s\n",label.c_str()); continue; }
        ++ok; printf("OK %llu %s\n",(unsigned long long)size,label.c_str()); fflush(stdout);
    }
    printf("DONE ok=%zu missing=%zu failed=%zu existing=%zu\n",ok,missing,failed,existing);
    fflush(stdout);
    // No client shutdown or package cleanup entrypoints are called.
    ExitProcess(failed?7:0);
}
