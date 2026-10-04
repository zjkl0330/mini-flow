window.__XHR=window.__XHR||[];
if(!window.__XHR_PATCHED){
  window.__XHR_PATCHED=true;
  var _open=XMLHttpRequest.prototype.open, _send=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(m,u){this.__m=m;this.__u=u;return _open.apply(this,arguments);};
  XMLHttpRequest.prototype.send=function(){
    var self=this;
    this.addEventListener('loadend',function(){
      try{ window.__XHR.push(self.status+' '+self.__m+' '+self.__u+' :: '+String(self.responseText||'').slice(0,220)); }catch(e){}
    });
    return _send.apply(this,arguments);
  };
}
'patched'
