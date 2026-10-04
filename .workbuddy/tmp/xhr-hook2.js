window.__XHR=window.__XHR||[];
var _send=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send=function(b){
  var self=this, body=b;
  this.addEventListener('loadend',function(){
    try{ window.__XHR.push(self.status+' '+self.__m+' '+self.__u+' BODY='+String(body==null?'':(typeof body==='string'?body:'[bin]')).slice(0,160)+' :: '+String(self.responseText||'').slice(0,160)); }catch(e){}
  });
  return _send.apply(this,arguments);
};
'done'
